const MAX_NODES = 220;
const NODE_RADIUS = 10;
const PHYSICS_FLOOR = 0.025;
const COLORS = {
    background: "#000",
    edge: "#285e32",
    edgeActive: "#55ff72",
    node: "#d8e1da",
    nodeFill: "#08130a",
    selected: "#00ff55",
    neighbor: "#87ff9b",
    ghost: "#555",
    muted: "#303030",
    grid: "#1d3d24",
    removing: "#ff5d5d",
    text: "#d8e1da",
};

const state = {
    rows: [],
    graph: { nodes: [], edges: [], truncated: false },
    selected: null,
    inspector: null,
    query: "",
    loading: false,
    ready: false,
};

const view = { x: 0, y: 0, scale: 1 };
let canvas;
let ctx;
let width = 1;
let height = 1;
let frame;
let alpha = 0;
let pointer = null;
let hovered = null;
let dragging = null;
let panning = false;
let liveSocket;
let liveTimer;
let refreshTimer;
let liveRefreshTimer;
let lastLiveRefresh = 0;

function api(path) {
    return fetch(path).then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.error) throw new Error(data.error || `request failed (${response.status})`);
        return data;
    });
}

function hash(text) {
    let value = 2166136261;
    for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
    return value >>> 0;
}

function nodeLabel(node) {
    return node.label && node.label !== node.soul ? node.label : node.soul.split("/").pop() || node.soul;
}

function previewValue(value) {
    if (value && typeof value === "object" && typeof value["#"] === "string") return `→ ${value["#"]}`;
    if (typeof value === "string") return value;
    if (value === null) return "null";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
}

function searchable(node) {
    return `${node.soul} ${node.label || ""} ${Object.values(node.fields || {}).join(" ")}`.toLowerCase();
}

function prepareGraph(data, previous = { nodes: [], edges: [] }, animateChanges = previous.nodes.length > 0) {
    const previousNodes = new Map(previous.nodes.map((node) => [node.soul, node]));
    const count = Math.max(data.nodes.length, 1);
    const nodes = data.nodes.map((node) => {
        const old = previousNodes.get(node.soul);
        const seed = hash(node.soul);
        const spread = 60 + Math.sqrt(count) * 30;
        return {
            ...node,
            x: old?.x ?? (((seed & 0xffff) / 0xffff) - 0.5) * spread * 2,
            y: old?.y ?? ((((seed >>> 16) & 0xffff) / 0xffff) - 0.5) * spread * 2,
            vx: old?.vx ?? 0,
            vy: old?.vy ?? 0,
            radius: NODE_RADIUS,
            degree: 0,
            opacity: old?.opacity ?? 0,
            pulse: !old
                ? Number(animateChanges)
                : JSON.stringify([old.label, old.fields, old.ghost]) !== JSON.stringify([node.label, node.fields, node.ghost])
                    ? 1
                    : old.pulse || 0,
        };
    });
    for (const old of previous.nodes) {
        if (!data.nodes.some((node) => node.soul === old.soul)) nodes.push({ ...old, exiting: true, pulse: 1 });
    }
    const bySoul = new Map(nodes.map((node) => [node.soul, node]));
    const previousEdges = new Map(previous.edges.map((edge) => [`${edge.from}\0${edge.field}\0${edge.to}`, edge]));
    const edges = data.edges
        .map((edge) => {
            const old = previousEdges.get(`${edge.from}\0${edge.field}\0${edge.to}`);
            return { ...edge, source: bySoul.get(edge.from), target: bySoul.get(edge.to), opacity: old?.opacity ?? 0 };
        })
        .filter((edge) => edge.source && edge.target);
    const edgeKeys = new Set(edges.map((edge) => `${edge.from}\0${edge.field}\0${edge.to}`));
    for (const old of previous.edges) {
        if (!edgeKeys.has(`${old.from}\0${old.field}\0${old.to}`)) {
            const source = bySoul.get(old.from);
            const target = bySoul.get(old.to);
            if (source && target) edges.push({ ...old, source, target, exiting: true });
        }
    }
    const pairs = new Map();
    for (const edge of edges) {
        if (!edge.exiting) {
            edge.source.degree++;
            edge.target.degree++;
        }
        const key = [edge.from, edge.to].sort().join("\0");
        const siblings = pairs.get(key) || [];
        siblings.push(edge);
        pairs.set(key, siblings);
    }
    for (const siblings of pairs.values()) {
        siblings.forEach((edge, index) => {
            const offset = (index - (siblings.length - 1) / 2) * 18;
            edge.curve = offset * (edge.from < edge.to ? 1 : -1);
        });
    }
    for (const node of nodes) node.radius = NODE_RADIUS + Math.min(8, Math.sqrt(node.degree) * 2.5);
    return { nodes, edges, truncated: Boolean(data.truncated) };
}

function tickPhysics(nodes, edges, strength, pinned) {
    // ponytail: O(n²) is fast enough for the 220-node cap; use a quadtree if that cap grows.
    for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
            const b = nodes[j];
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            const d2 = Math.max(dx * dx + dy * dy, 25);
            const force = (900 * strength) / d2;
            const distance = Math.sqrt(d2);
            dx /= distance;
            dy /= distance;
            a.vx -= dx * force;
            a.vy -= dy * force;
            b.vx += dx * force;
            b.vy += dy * force;
        }
    }
    for (const edge of edges) {
        const dx = edge.target.x - edge.source.x;
        const dy = edge.target.y - edge.source.y;
        const distance = Math.max(Math.hypot(dx, dy), 1);
        const force = (distance - 105) * 0.008 * strength;
        edge.source.vx += (dx / distance) * force;
        edge.source.vy += (dy / distance) * force;
        edge.target.vx -= (dx / distance) * force;
        edge.target.vy -= (dy / distance) * force;
    }
    for (const node of nodes) {
        if (node === pinned) {
            node.vx = node.vy = 0;
            continue;
        }
        node.vx += -node.x * 0.0015 * strength;
        node.vy += -node.y * 0.0015 * strength;
        node.vx *= 0.84;
        node.vy *= 0.84;
        node.x += node.vx;
        node.y += node.vy;
    }
}

function settleGraph(graph, iterations = 140) {
    for (let i = 0; i < iterations; i++) {
        tickPhysics(graph.nodes, graph.edges, Math.max(0.08, 1 - i / iterations));
    }
    for (const node of graph.nodes) node.vx = node.vy = 0;
    return graph;
}

function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    width = Math.max(1, rect.width);
    height = Math.max(1, rect.height);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
}

function screen(node) {
    return {
        x: width / 2 + view.x + node.x * view.scale,
        y: height / 2 + view.y + node.y * view.scale,
    };
}

function world(x, y) {
    return {
        x: (x - width / 2 - view.x) / view.scale,
        y: (y - height / 2 - view.y) / view.scale,
    };
}

function activeSouls() {
    if (!state.selected) return new Set();
    const souls = new Set([state.selected]);
    for (const edge of state.graph.edges) {
        if (edge.from === state.selected) souls.add(edge.to);
        if (edge.to === state.selected) souls.add(edge.from);
    }
    return souls;
}

function simulate() {
    const nodes = state.graph.nodes;
    const edges = state.graph.edges;
    alpha = Math.max(PHYSICS_FLOOR, alpha * 0.965);

    for (const node of nodes) {
        node.opacity = Math.max(0, Math.min(1, node.opacity + (node.exiting ? -0.014 : 0.02)));
        node.pulse = Math.max(0, (node.pulse || 0) - 0.008);
    }
    for (const edge of edges) edge.opacity = Math.max(0, Math.min(1, edge.opacity + (edge.exiting ? -0.02 : 0.028)));
    tickPhysics(nodes, edges, alpha, dragging);
    draw();
    state.graph.nodes = nodes.filter((node) => !node.exiting || node.opacity > 0);
    state.graph.edges = edges.filter((edge) => !edge.exiting || edge.opacity > 0);
    frame = requestAnimationFrame(simulate);
}

function restartSimulation(value = 1) {
    alpha = Math.max(alpha, value);
    if (!frame) frame = requestAnimationFrame(simulate);
}

function drawArrow(edge, active) {
    const from = screen(edge.source);
    const to = screen(edge.target);
    if (edge.source === edge.target) {
        const radius = Math.max(13, edge.source.radius * view.scale + 7);
        ctx.strokeStyle = edge.exiting ? COLORS.removing : active ? COLORS.edgeActive : COLORS.edge;
        ctx.fillStyle = ctx.strokeStyle;
        ctx.globalAlpha = (active ? 0.9 : 0.55) * edge.opacity;
        ctx.lineWidth = active ? 1.5 : 1;
        ctx.beginPath();
        ctx.arc(from.x + radius * 0.65, from.y - radius * 0.65, radius, 0.35 * Math.PI, 1.9 * Math.PI);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(from.x + radius * 1.55, from.y - radius * 0.15);
        ctx.lineTo(from.x + radius * 1.05, from.y - radius * 0.4);
        ctx.lineTo(from.x + radius * 1.5, from.y - radius * 0.65);
        ctx.closePath();
        ctx.fill();
        if (active || view.scale > 1.25) {
            ctx.fillStyle = edge.exiting ? COLORS.removing : active ? COLORS.neighbor : "#718075";
            ctx.font = "9px monospace";
            ctx.textAlign = "left";
            ctx.fillText(edge.field, from.x + radius * 1.2, from.y - radius * 1.4);
        }
        return;
    }
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.max(Math.hypot(dx, dy), 1);
    const ux = dx / distance;
    const uy = dy / distance;
    const curve = edge.curve || 0;
    const cx = (from.x + to.x) / 2 - uy * curve;
    const cy = (from.y + to.y) / 2 + ux * curve;
    const start = edge.source.radius * view.scale;
    const end = edge.target.radius * view.scale + 4;
    const x1 = from.x + ux * start;
    const y1 = from.y + uy * start;
    const x2 = to.x - ux * end;
    const y2 = to.y - uy * end;

    ctx.strokeStyle = edge.exiting ? COLORS.removing : active ? COLORS.edgeActive : COLORS.edge;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.globalAlpha = (active ? 0.9 : 0.55) * edge.opacity;
    ctx.lineWidth = active ? 1.5 : 1;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.quadraticCurveTo(cx, cy, x2, y2);
    ctx.stroke();
    const endAngle = Math.atan2(y2 - cy, x2 - cx);
    const endX = Math.cos(endAngle);
    const endY = Math.sin(endAngle);
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - endX * 7 - endY * 4, y2 - endY * 7 + endX * 4);
    ctx.lineTo(x2 - endX * 7 + endY * 4, y2 - endY * 7 - endX * 4);
    ctx.closePath();
    ctx.fill();

    if ((active || view.scale > 1.25) && distance > 55) {
        ctx.globalAlpha = (active ? 1 : 0.65) * edge.opacity;
        ctx.fillStyle = edge.exiting ? COLORS.removing : active ? COLORS.neighbor : "#718075";
        ctx.font = "9px monospace";
        ctx.textAlign = "center";
        ctx.fillText(edge.field, cx, cy - 5);
    }
}

function gridStep(scale) {
    let step = 22 * scale;
    while (step < 14) step *= 2;
    while (step > 44) step /= 2;
    return step;
}

function drawGrid() {
    const step = gridStep(view.scale);
    const offsetX = ((width / 2 + view.x) % step + step) % step;
    const offsetY = ((height / 2 + view.y) % step + step) % step;
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = COLORS.grid;
    for (let x = offsetX; x < width; x += step) {
        for (let y = offsetY; y < height; y += step) {
            ctx.beginPath();
            ctx.arc(x, y, 1, 0, Math.PI * 2);
            ctx.fill();
        }
    }
    ctx.globalAlpha = 1;
}

function draw() {
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    drawGrid();
    const active = activeSouls();
    const filtering = Boolean(state.query);
    const matches = filtering
        ? new Set(state.graph.nodes.filter((node) => searchable(node).includes(state.query)).map((node) => node.soul))
        : null;

    for (const edge of state.graph.edges) {
        const edgeActive = state.selected && (edge.from === state.selected || edge.to === state.selected);
        drawArrow(edge, edgeActive);
    }

    for (const node of state.graph.nodes) {
        const point = screen(node);
        const selected = node.soul === state.selected;
        const neighbor = active.has(node.soul);
        const matched = !matches || matches.has(node.soul);
        const radius = Math.max(4, node.radius * view.scale);
        if (node.pulse > 0) {
            ctx.globalAlpha = node.opacity * Math.sqrt(node.pulse);
            ctx.strokeStyle = node.exiting ? COLORS.removing : COLORS.selected;
            ctx.lineWidth = 2.5;
            for (const offset of [0, 10]) {
                ctx.beginPath();
                ctx.arc(point.x, point.y, radius + offset + (1 - node.pulse) * 40, 0, Math.PI * 2);
                ctx.stroke();
            }
        }
        ctx.globalAlpha = (matched ? 1 : 0.15) * node.opacity;
        ctx.fillStyle = node.exiting ? "#1b0808" : node.ghost ? "#090909" : COLORS.nodeFill;
        ctx.strokeStyle = node.exiting ? COLORS.removing : selected ? COLORS.selected : node.ghost ? COLORS.ghost : neighbor ? COLORS.neighbor : COLORS.node;
        ctx.lineWidth = selected ? 2.5 : 1.25;
        if (node.ghost) ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.setLineDash([]);

        if (selected || hovered === node || view.scale > 0.72) {
            ctx.globalAlpha = (matched ? 1 : 0.2) * node.opacity;
            ctx.fillStyle = node.exiting ? COLORS.removing : selected ? COLORS.selected : COLORS.text;
            ctx.font = `${selected ? "bold " : ""}10px monospace`;
            ctx.textAlign = "center";
            ctx.fillText(nodeLabel(node).slice(0, 34), point.x, point.y + radius + 14);
        }
    }
    ctx.globalAlpha = 1;
}

function fitGraph() {
    const nodes = state.graph.nodes;
    if (!nodes.length) return;
    const minX = Math.min(...nodes.map((node) => node.x - node.radius));
    const maxX = Math.max(...nodes.map((node) => node.x + node.radius));
    const minY = Math.min(...nodes.map((node) => node.y - node.radius));
    const maxY = Math.max(...nodes.map((node) => node.y + node.radius));
    view.scale = Math.min(2, Math.max(0.15, Math.min((width - 100) / Math.max(1, maxX - minX), (height - 100) / Math.max(1, maxY - minY))));
    view.x = -((minX + maxX) / 2) * view.scale;
    view.y = -((minY + maxY) / 2) * view.scale;
    draw();
}

function hitNode(x, y) {
    for (let i = state.graph.nodes.length - 1; i >= 0; i--) {
        const node = state.graph.nodes[i];
        if (node.exiting) continue;
        const point = screen(node);
        if (Math.hypot(point.x - x, point.y - y) <= Math.max(9, node.radius * view.scale + 4)) return node;
    }
    return null;
}

function canvasPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function bindCanvas() {
    canvas.addEventListener("pointerdown", (event) => {
        canvas.setPointerCapture(event.pointerId);
        const point = canvasPoint(event);
        const node = hitNode(point.x, point.y);
        pointer = { ...point, clientX: event.clientX, clientY: event.clientY, moved: false };
        if (node) {
            dragging = node;
            node.vx = node.vy = 0;
        } else {
            panning = true;
        }
    });
    canvas.addEventListener("pointermove", (event) => {
        const point = canvasPoint(event);
        if (pointer) {
            const dx = event.clientX - pointer.clientX;
            const dy = event.clientY - pointer.clientY;
            pointer.moved ||= Math.abs(dx) + Math.abs(dy) > 3;
            pointer.clientX = event.clientX;
            pointer.clientY = event.clientY;
            if (dragging) Object.assign(dragging, world(point.x, point.y), { vx: 0, vy: 0 });
            if (panning) {
                view.x += dx;
                view.y += dy;
            }
            draw();
            return;
        }
        const next = hitNode(point.x, point.y);
        if (hovered !== next) {
            hovered = next;
            canvas.style.cursor = next ? "pointer" : "grab";
            renderTooltip(event, next);
            draw();
        } else if (next) {
            renderTooltip(event, next);
        }
    });
    const release = (event) => {
        const backgroundClick = event.type === "pointerup" && panning && pointer && !pointer.moved;
        if (dragging && pointer && !pointer.moved) selectNode(dragging.soul);
        dragging = null;
        panning = false;
        pointer = null;
        if (backgroundClick) clearSelection();
    };
    canvas.addEventListener("pointerup", release);
    canvas.addEventListener("pointercancel", release);
    canvas.addEventListener("pointerleave", () => {
        if (!pointer) {
            hovered = null;
            document.getElementById("graphTooltip").hidden = true;
            draw();
        }
    });
    canvas.addEventListener("wheel", (event) => {
        event.preventDefault();
        const point = canvasPoint(event);
        const before = world(point.x, point.y);
        view.scale = Math.min(4, Math.max(0.12, view.scale * Math.exp(-event.deltaY * 0.001)));
        const after = screen(before);
        view.x += point.x - after.x;
        view.y += point.y - after.y;
        draw();
    }, { passive: false });
}

function renderTooltip(event, node) {
    const tooltip = document.getElementById("graphTooltip");
    if (!node) {
        tooltip.hidden = true;
        return;
    }
    tooltip.replaceChildren();
    const title = document.createElement("strong");
    title.textContent = nodeLabel(node);
    const soul = document.createElement("span");
    soul.textContent = node.soul;
    const meta = document.createElement("small");
    meta.textContent = node.ghost ? "referenced but not stored" : `${Object.keys(node.fields || {}).length} preview fields · ${node.degree} relations`;
    tooltip.append(title, soul, meta);
    tooltip.style.left = `${event.clientX + 14}px`;
    tooltip.style.top = `${event.clientY + 14}px`;
    tooltip.hidden = false;
}

function typeOfValue(value, key = "") {
    if (value && typeof value === "object" && !Array.isArray(value) && typeof value["#"] === "string") return "reference";
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    if (typeof value === "object") return "object";
    if (typeof value !== "string") return typeof value;
    const trimmed = value.trim();
    if (/^data:image\//i.test(trimmed) || /\.(avif|gif|jpe?g|png|svg|webp)(\?.*)?$/i.test(trimmed)) return "image";
    if (/^data:video\//i.test(trimmed) || /\.(mp4|webm|ogv|mov)(\?.*)?$/i.test(trimmed)) return "video";
    if (/^data:audio\//i.test(trimmed) || /\.(mp3|m4a|ogg|wav|flac)(\?.*)?$/i.test(trimmed)) return "audio";
    if (/^https?:\/\//i.test(trimmed)) return "url";
    if ((trimmed.startsWith("{") || trimmed.startsWith("["))) {
        try {
            JSON.parse(trimmed);
            return "json";
        } catch {}
    }
    return trimmed.includes("\n") || trimmed.length > 120 ? "text" : "string";
}

function valueElement(value, type) {
    if (type === "reference") {
        const button = document.createElement("button");
        button.className = "explorer-ref";
        button.textContent = `→ ${value["#"]}`;
        button.addEventListener("click", () => selectNode(value["#"]));
        return button;
    }
    if (type === "image") {
        const link = document.createElement("a");
        link.href = value;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        const image = document.createElement("img");
        image.src = value;
        image.alt = "";
        image.loading = "lazy";
        link.append(image);
        return link;
    }
    if (type === "video" || type === "audio") {
        const media = document.createElement(type);
        media.src = value;
        media.controls = true;
        media.preload = "metadata";
        return media;
    }
    if (type === "url") {
        const link = document.createElement("a");
        link.href = value;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = value;
        return link;
    }
    if (type === "object" || type === "array" || type === "json") {
        const details = document.createElement("details");
        const summary = document.createElement("summary");
        const parsed = type === "json" ? JSON.parse(value) : value;
        summary.textContent = type === "array" ? `${parsed.length} items` : `${Object.keys(parsed).length} entries`;
        const pre = document.createElement("pre");
        pre.textContent = JSON.stringify(parsed, null, 2);
        details.append(summary, pre);
        return details;
    }
    const output = document.createElement(type === "text" ? "pre" : "span");
    output.textContent = value === null ? "null" : String(value);
    return output;
}

function renderInspector() {
    const empty = document.getElementById("inspectorEmpty");
    const content = document.getElementById("inspectorContent");
    document.querySelector(".explorer-inspector").classList.toggle("open", Boolean(state.selected));
    if (!state.selected) {
        empty.hidden = false;
        content.hidden = true;
        return;
    }
    empty.hidden = true;
    content.hidden = false;
    const graphNode = state.graph.nodes.find((node) => node.soul === state.selected);
    const data = state.inspector;
    document.getElementById("inspectorKind").textContent = graphNode?.ghost && !data ? "missing target" : "stored node";
    document.getElementById("inspectorLabel").textContent = data?.label || graphNode?.label || state.selected;
    document.getElementById("inspectorSoul").textContent = state.selected;
    document.getElementById("inspectorMeta").textContent = data
        ? `${new Date(data.updated).toLocaleString()} · ${data.refs.length} outgoing relations`
        : "This soul is referenced by another node but is not stored on this peer.";
    document.getElementById("inspectorRaw").textContent = data ? JSON.stringify(data.raw, null, 2) : "";

    const fields = document.getElementById("inspectorFields");
    fields.replaceChildren();
    for (const [key, value] of Object.entries(data?.raw || {})) {
        if (key === "_") continue;
        const type = typeOfValue(value, key);
        const article = document.createElement("article");
        const head = document.createElement("div");
        const name = document.createElement("strong");
        name.textContent = key;
        const badge = document.createElement("span");
        badge.textContent = type;
        head.append(name, badge);
        article.append(head, valueElement(value, type));
        fields.append(article);
    }
}

function renderList() {
    const list = document.getElementById("nodeList");
    list.replaceChildren();
    const rows = state.rows.filter((row) => {
        const node = state.graph.nodes.find((item) => item.soul === row.soul);
        return !state.query || `${row.soul} ${row.label || ""} ${node ? searchable(node) : ""}`.toLowerCase().includes(state.query);
    });
    for (const row of rows) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "explorer-node-row";
        button.classList.toggle("selected", row.soul === state.selected);
        const label = document.createElement("strong");
        label.textContent = row.label || row.soul;
        const soul = document.createElement("span");
        soul.textContent = row.soul;
        button.append(label, soul);
        button.addEventListener("click", () => selectNode(row.soul));
        list.append(button);
    }
    if (!rows.length) {
        const message = document.createElement("p");
        message.className = "explorer-no-results";
        message.textContent = state.query ? "no matching nodes" : "no stored nodes";
        list.append(message);
    }
    document.getElementById("nodeCount").textContent = `(${state.rows.length}${state.graph.truncated ? "+" : ""})`;
}

function renderStatus(message) {
    document.getElementById("statusBar").textContent = message || [
        `${state.graph.nodes.filter((node) => !node.ghost && !node.exiting).length} stored nodes`,
        `${state.graph.edges.filter((edge) => !edge.exiting).length} references`,
        state.graph.nodes.some((node) => node.ghost && !node.exiting) ? `${state.graph.nodes.filter((node) => node.ghost && !node.exiting).length} missing targets` : "",
        state.graph.truncated ? `limited to ${MAX_NODES}` : "",
        "drag nodes · drag background · scroll to zoom",
    ].filter(Boolean).join(" · ");
}

async function selectNode(soul) {
    state.selected = soul;
    state.inspector = null;
    renderList();
    renderInspector();
    draw();
    try {
        state.inspector = await api(`/api/graph/node?soul=${encodeURIComponent(soul)}`);
    } catch (error) {
        if (!state.graph.nodes.find((node) => node.soul === soul)?.ghost) renderStatus(error.message);
    }
    renderInspector();
}

function clearSelection() {
    state.selected = null;
    state.inspector = null;
    renderList();
    renderInspector();
    draw();
}

async function loadGraph({ fit = false, quiet = false } = {}) {
    if (state.loading) {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => loadGraph({ fit, quiet }), 120);
        return;
    }
    state.loading = true;
    if (!quiet) renderStatus("loading graph…");
    try {
        const [souls, graph, stats] = await Promise.all([
            api("/api/graph/souls?limit=500&sort=updated"),
            api(`/api/graph/subgraph?maxNodes=${MAX_NODES}&depth=0`),
            api("/api/stats"),
        ]);
        state.rows = souls.souls || [];
        const selectedExists = !state.selected || graph.nodes.some((node) => node.soul === state.selected);
        state.graph = prepareGraph(graph, state.ready ? state.graph : undefined, state.ready);
        if (!state.ready) settleGraph(state.graph);
        if (!liveSocket || liveSocket.readyState !== WebSocket.OPEN) {
            document.getElementById("peerStatus").textContent = stats.status || "online";
            document.getElementById("peerStatus").className = `explorer-peer ${stats.status === "online" ? "online" : ""}`;
        }
        document.getElementById("emptyState").hidden = graph.nodes.length > 0;
        document.getElementById("emptyState").textContent = "no graph nodes are stored on this peer yet";
        if (!selectedExists) {
            state.selected = null;
            state.inspector = null;
        } else if (state.selected) {
            state.inspector = await api(`/api/graph/node?soul=${encodeURIComponent(state.selected)}`).catch(() => null);
        }
        renderList();
        renderInspector();
        restartSimulation(state.ready ? 0.45 : 1);
        if (fit || !state.ready) fitGraph();
        state.ready = true;
        renderStatus();
    } catch (error) {
        document.getElementById("peerStatus").textContent = "error";
        document.getElementById("peerStatus").className = "explorer-peer error";
        renderStatus(error.message);
    } finally {
        state.loading = false;
    }
}

function connectLive() {
    clearTimeout(liveTimer);
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    liveSocket = new WebSocket(`${protocol}//${location.host}/gun`);
    liveSocket.addEventListener("open", () => {
        document.getElementById("peerStatus").textContent = "live";
        document.getElementById("peerStatus").className = "explorer-peer online";
    });
    liveSocket.addEventListener("message", (event) => {
        try {
            const messages = JSON.parse(event.data);
            if (!(Array.isArray(messages) ? messages : [messages]).some((message) => message?.put)) return;
            if (liveRefreshTimer) return;
            liveRefreshTimer = setTimeout(() => {
                liveRefreshTimer = null;
                lastLiveRefresh = Date.now();
                loadGraph({ quiet: true });
            }, Math.max(90, 400 - (Date.now() - lastLiveRefresh)));
        } catch {}
    });
    liveSocket.addEventListener("close", () => {
        document.getElementById("peerStatus").textContent = "reconnecting";
        document.getElementById("peerStatus").className = "explorer-peer";
        liveTimer = setTimeout(connectLive, 1500);
    });
    liveSocket.addEventListener("error", () => liveSocket.close());
}

function init() {
    canvas = document.getElementById("graphCanvas");
    ctx = canvas.getContext("2d");
    bindCanvas();
    new ResizeObserver(resize).observe(canvas);
    document.getElementById("fitBtn").addEventListener("click", fitGraph);
    document.getElementById("refreshBtn").addEventListener("click", () => loadGraph({ fit: true }));
    document.getElementById("searchInput").addEventListener("input", (event) => {
        state.query = event.target.value.trim().toLowerCase();
        renderList();
        draw();
    });
    document.getElementById("copySoulBtn").addEventListener("click", async (event) => {
        await navigator.clipboard.writeText(state.selected);
        event.target.textContent = "copied";
        setTimeout(() => { event.target.textContent = "copy soul"; }, 1000);
    });
    document.getElementById("closeInspectorBtn").addEventListener("click", clearSelection);
    loadGraph({ fit: true });
    connectLive();
    // ponytail: Gun broadcasts writes; this slow pass only catches storage eviction/removal.
    setInterval(() => loadGraph({ quiet: true }), 15_000);
}

if (typeof document !== "undefined") init();

export { gridStep, prepareGraph, previewValue, settleGraph, typeOfValue };
