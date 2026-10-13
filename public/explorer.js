import { groupInspectorFields } from "./graph-inspector.js";

const MAX_NODES = 220;
const LIST_LIMIT = 500;
// ponytail: live puts patch only the changed souls; full reloads are a slow visible-only safety net.
const FULL_REFRESH_MS = 5 * 60 * 1000;
const STALE_ON_SHOW_MS = 60 * 1000;
const LIVE_PATCH_MS = 1500;
const LIVE_PATCH_MAX_SOULS = 50;
const LIVE_RECONNECT_MIN_MS = 1500;
const LIVE_RECONNECT_MAX_MS = 60 * 1000;
const NODE_RADIUS = 13;
const PHYSICS_FLOOR = 0.3;
const LABEL_GAP = 26;

function nodeMass(degree) {
    return 1 + Math.sqrt(degree) * 0.5;
}

function nodeRadius(degree) {
    return NODE_RADIUS + Math.min(14, Math.sqrt(degree) * 4 + degree * 0.35);
}

function layoutSpacing(nodeCount) {
    return 62 + Math.sqrt(Math.max(nodeCount, 1)) * 14;
}

function initialNodePosition(soul, index, count) {
    const seed = hash(soul);
    const ring = layoutSpacing(count) * (0.85 + Math.sqrt(count) * 0.08);
    const angle = (index / Math.max(count, 1)) * Math.PI * 2 + ((seed % 360) * Math.PI) / 180;
    const jitter = layoutSpacing(count) * 0.12;
    return {
        x: Math.cos(angle) * ring + (((seed & 0xff) / 255) - 0.5) * jitter,
        y: Math.sin(angle) * ring + ((((seed >>> 8) & 0xff) / 255) - 0.5) * jitter,
    };
}

function graphColors() {
    const v = (name) => (typeof getComputedStyle === "undefined" ? "" : getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim());
    return {
        background: v('graph-bg'),
        edge: v('graph-edge'),
        edgeActive: v('graph-edge-active'),
        node: v('graph-node'),
        nodeFill: v('graph-node-fill'),
        selected: v('graph-selected'),
        neighbor: v('graph-neighbor'),
        ghost: v('graph-ghost'),
        muted: v('graph-muted'),
        grid: v('graph-grid'),
        removing: v('graph-removing'),
        text: v('graph-node'),
        edgeIdle: v('graph-edge-idle'),
        nodeExit: v('graph-node-exit'),
        nodeGhostFill: v('graph-node-ghost-fill'),
    };
}

let COLORS = graphColors();

const state = {
    rows: [],
    graph: { nodes: [], edges: [], truncated: false },
    selected: null,
    inspector: null,
    query: "",
    loading: false,
    ready: false,
};

const view = { x: 0, y: 0, scale: 1, baseScale: 1 };

function labelBaseScale() {
    return view.baseScale || view.scale;
}

function showNodeLabels() {
    return view.scale >= labelBaseScale() * 0.9;
}

function showEdgeLabels(active = false) {
    return active || view.scale >= labelBaseScale() * 1.1;
}
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
let lastFullLoad = 0;
let liveReconnectDelay = LIVE_RECONNECT_MIN_MS;
const pendingLiveSouls = new Set();
let searchTimer;

const peer = { gunUrl: null, origin: null };

function peerOrigin() {
    return peer.origin || location.origin;
}

function peerGunWsUrl() {
    if (peer.gunUrl) {
        const parsed = new URL(peer.gunUrl);
        parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
        return parsed.toString().replace(/\/$/, "");
    }
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${location.host}/gun`;
}

function normalizePeerUrlInput(raw) {
    if (typeof raw !== "string" || !raw.trim()) {
        return { ok: false, error: "url required" };
    }
    let input = raw.trim();
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
        input = `https://${input}`;
    }
    let parsed;
    try {
        parsed = new URL(input);
    } catch {
        return { ok: false, error: "invalid url" };
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return { ok: false, error: "only http(s) peer urls allowed" };
    }
    let path = parsed.pathname.replace(/\/+$/, "") || "";
    if (!path.endsWith("/gun")) {
        path = `${path}/gun`.replace(/\/{2,}/g, "/");
    }
    parsed.pathname = path;
    return { ok: true, url: parsed.toString().replace(/\/$/, "") };
}

async function verifyGunPeer(url) {
    const response = await fetch("/api/peers/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
        throw new Error(data.error || "not a valid gun peer");
    }
    if (!data.reachable || !data.verified) {
        throw new Error("peer failed gun verification");
    }
    return data.url;
}

function setActivePeer(gunUrl) {
    peer.gunUrl = gunUrl;
    peer.origin = gunUrl ? new URL(gunUrl).origin : null;
}

function api(path) {
    return fetch(`${peerOrigin()}${path}`).then(async (response) => {
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
    const nodes = data.nodes.map((node, index) => {
        const old = previousNodes.get(node.soul);
        const start = initialNodePosition(node.soul, index, count);
        return {
            ...node,
            x: old?.x ?? start.x,
            y: old?.y ?? start.y,
            vx: old?.vx ?? 0,
            vy: old?.vy ?? 0,
            radius: NODE_RADIUS,
            mass: 1,
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
            const offset = (index - (siblings.length - 1) / 2) * 24;
            edge.curve = offset * (edge.from < edge.to ? 1 : -1);
        });
    }
    for (const node of nodes) {
        node.radius = nodeRadius(node.degree);
        node.mass = nodeMass(node.degree);
    }
    return { nodes, edges, truncated: Boolean(data.truncated) };
}

function rowOf(node) {
    return { soul: node.soul, label: node.label, updated: node.updated };
}

/**
 * Fold a `roots=<dirty souls>&depth=0` subgraph into the current view.
 * Dirty souls missing from the patch were tombstoned or evicted, so they drop out.
 * Returns null when the result would exceed MAX_NODES (caller does a full reload).
 */
function mergeLivePatch(graph, rows, patch, dirtySouls, allowNew = true) {
    const dirty = new Set(dirtySouls);
    const fresh = new Map((patch.nodes || []).filter((node) => !node.ghost).map((node) => [node.soul, node]));
    const ghosts = new Map((patch.nodes || []).filter((node) => node.ghost).map((node) => [node.soul, node]));
    const current = graph.nodes.filter((node) => !node.exiting);
    const present = new Set(current.map((node) => node.soul));

    const nodes = current
        .filter((node) => !dirty.has(node.soul) || fresh.has(node.soul) || node.ghost)
        .map((node) => fresh.get(node.soul) || node);
    if (allowNew) {
        for (const node of fresh.values()) if (!present.has(node.soul)) nodes.push(node);
    }

    const souls = new Set(nodes.map((node) => node.soul));
    const edges = graph.edges
        .filter((edge) => !edge.exiting && !dirty.has(edge.from) && souls.has(edge.from) && souls.has(edge.to))
        .map(({ from, to, field }) => ({ from, to, field }));
    for (const edge of patch.edges || []) {
        if (!souls.has(edge.from)) continue;
        if (!souls.has(edge.to)) {
            const ghost = ghosts.get(edge.to);
            if (!ghost) continue;
            nodes.push(ghost);
            souls.add(edge.to);
        }
        edges.push(edge);
    }
    if (nodes.length > MAX_NODES) return null;

    const listed = new Set(rows.map((row) => row.soul));
    const nextRows = rows
        .filter((row) => !dirty.has(row.soul) || fresh.has(row.soul))
        .map((row) => (fresh.has(row.soul) ? rowOf(fresh.get(row.soul)) : row));
    if (allowNew) {
        for (const node of fresh.values()) if (!listed.has(node.soul)) nextRows.push(rowOf(node));
    }
    nextRows.sort((a, b) => (b.updated || 0) - (a.updated || 0) || a.soul.localeCompare(b.soul));

    return { nodes, edges, rows: nextRows.slice(0, LIST_LIMIT), truncated: graph.truncated };
}

function tickPhysics(nodes, edges, strength, pinned) {
    // ponytail: O(n²) is fast enough for the 220-node cap; use a quadtree if that cap grows.
    const k = layoutSpacing(nodes.length);
    for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
            const b = nodes[j];
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            let dist = Math.hypot(dx, dy);
            const minDist = a.radius + b.radius + LABEL_GAP;
            if (dist < 0.01) {
                dx = (hash(a.soul) % 100 - 50) * 0.002;
                dy = (hash(b.soul) % 100 - 50) * 0.002;
                dist = Math.hypot(dx, dy) || 0.01;
            }
            let force;
            if (dist < minDist) {
                force = ((minDist - dist) / dist) * 0.85 * strength;
            } else {
                force = ((k * k) / (dist * dist)) * 0.48 * strength;
            }
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            a.vx -= fx / a.mass;
            a.vy -= fy / a.mass;
            b.vx += fx / b.mass;
            b.vy += fy / b.mass;
        }
    }
    for (const edge of edges) {
        if (edge.exiting) continue;
        const dx = edge.target.x - edge.source.x;
        const dy = edge.target.y - edge.source.y;
        const dist = Math.max(Math.hypot(dx, dy), 1);
        const hub = Math.sqrt((edge.source.degree + 1) * (edge.target.degree + 1));
        const rest = k * (0.95 + hub * 0.035);
        const spring = (0.01 * strength) / Math.sqrt(edge.source.degree + edge.target.degree + 2);
        const force = (dist - rest) * spring;
        edge.source.vx += (dx / dist) * force / edge.source.mass;
        edge.source.vy += (dy / dist) * force / edge.source.mass;
        edge.target.vx -= (dx / dist) * force / edge.target.mass;
        edge.target.vy -= (dy / dist) * force / edge.target.mass;
    }
    for (const node of nodes) {
        if (node === pinned) {
            node.vx = node.vy = 0;
            continue;
        }
        node.vx += (-node.x * 0.0011 * strength) / node.mass;
        node.vy += (-node.y * 0.0011 * strength) / node.mass;
        const damp = dragging ? 0.965 : 0.945;
        node.vx *= damp;
        node.vy *= damp;
        if (!dragging && Math.hypot(node.vx, node.vy) < 0.03) {
            node.vx = node.vy = 0;
        }
        node.x += node.vx;
        node.y += node.vy;
    }
}

function settleGraph(graph, iterations = 220) {
    for (let i = 0; i < iterations; i++) {
        tickPhysics(graph.nodes, graph.edges, Math.max(0.1, 1 - i / iterations));
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
    if (dragging) alpha = 1;
    else if (alpha > PHYSICS_FLOOR) alpha = Math.max(PHYSICS_FLOOR, alpha * 0.996);

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
    if (value >= 1) alpha = 1;
    else if (alpha < value) alpha = value;
    if (!frame) frame = requestAnimationFrame(simulate);
}

function drawArrow(edge, active, dim = 1) {
    const from = screen(edge.source);
    const to = screen(edge.target);
    if (edge.source === edge.target) {
        const radius = Math.max(13, edge.source.radius * view.scale + 7);
        ctx.strokeStyle = edge.exiting ? COLORS.removing : active ? COLORS.edgeActive : COLORS.edge;
        ctx.fillStyle = ctx.strokeStyle;
        ctx.globalAlpha = (active ? 0.9 : 0.55) * edge.opacity * dim;
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
        if (showEdgeLabels(active)) {
            ctx.fillStyle = edge.exiting ? COLORS.removing : active ? COLORS.neighbor : COLORS.edgeIdle;
            ctx.font = "11px monospace";
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
    ctx.globalAlpha = (active ? 0.9 : 0.55) * edge.opacity * dim;
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

    if (showEdgeLabels(active) && distance > 55) {
        ctx.globalAlpha = (active ? 1 : 0.65) * edge.opacity * dim;
        ctx.fillStyle = edge.exiting ? COLORS.removing : active ? COLORS.neighbor : COLORS.edgeIdle;
        ctx.font = "11px monospace";
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
    COLORS = graphColors();
    ctx.clearRect(0, 0, width, height);
    drawGrid();
    const active = activeSouls();
    const focusing = Boolean(state.selected);
    const filtering = Boolean(state.query);
    const matches = filtering
        ? new Set(state.graph.nodes.filter((node) => searchable(node).includes(state.query)).map((node) => node.soul))
        : null;

    for (const edge of state.graph.edges) {
        const edgeActive = state.selected && (edge.from === state.selected || edge.to === state.selected);
        const edgeDim = focusing && !(active.has(edge.from) && active.has(edge.to)) ? 0.5 : 1;
        drawArrow(edge, edgeActive, edgeDim);
    }

    for (const node of state.graph.nodes) {
        const point = screen(node);
        const selected = node.soul === state.selected;
        const neighbor = active.has(node.soul);
        const matched = !matches || matches.has(node.soul);
        const selectDim = focusing && !neighbor ? 0.5 : 1;
        const radius = Math.max(5, node.radius * view.scale);
        if (node.pulse > 0) {
            ctx.globalAlpha = node.opacity * Math.sqrt(node.pulse);
            ctx.strokeStyle = node.exiting ? COLORS.removing : COLORS.selected;
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            ctx.arc(point.x, point.y, radius + (1 - node.pulse) * 40, 0, Math.PI * 2);
            ctx.stroke();
        }
        ctx.globalAlpha = (matched ? 1 : 0.15) * node.opacity * selectDim;
        ctx.fillStyle = node.exiting ? COLORS.nodeExit : node.ghost ? COLORS.nodeGhostFill : COLORS.nodeFill;
        ctx.strokeStyle = node.exiting ? COLORS.removing : selected ? COLORS.selected : node.ghost ? COLORS.ghost : neighbor ? COLORS.neighbor : COLORS.node;
        ctx.lineWidth = selected ? 2.5 : 1.25;
        if (node.ghost) ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.setLineDash([]);

        if (!node.exiting && showNodeLabels()) {
            ctx.globalAlpha = (matched ? 1 : 0.2) * node.opacity * selectDim;
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
    view.baseScale = view.scale;
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
            restartSimulation(1);
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
            canvas.classList.toggle('is-pointer', Boolean(next));
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
            canvas.classList.remove('is-pointer');
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

function formatBytes(bytes) {
    if (bytes == null || !Number.isFinite(bytes)) return "unknown";
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
    return `${parseFloat((bytes / k ** i).toFixed(bytes < 10 && i > 0 ? 1 : 0))} ${sizes[i]}`;
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
    meta.textContent = node.ghost
        ? "referenced but not stored"
        : `${Object.keys(node.fields || {}).length} preview fields · ${node.degree} relations · ${formatBytes(node.bytes)}`;
    tooltip.append(title, soul, meta);
    tooltip.style.left = `${event.clientX + 14}px`;
    tooltip.style.top = `${event.clientY + 14}px`;
    tooltip.hidden = false;
}

const inspectorViews = {
    soul: null,
    raw: null,
    fields: new Map(),
};

function pathKey(path) {
    return path.length ? path.map(String).join(".") : "root";
}

function jsonDiffPaths(a, b, path = []) {
    const changed = new Set();
    const added = new Set();
    const removed = new Set();
    if (a === b) return { changed, added, removed };
    const key = pathKey(path);
    if (a == null || b == null || typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b)) {
        if (a !== b) changed.add(key);
        return { changed, added, removed };
    }
    if (typeof a !== "object") {
        if (a !== b) changed.add(key);
        return { changed, added, removed };
    }
    if (Array.isArray(a)) {
        const maxLen = Math.max(a.length, b.length);
        for (let i = 0; i < maxLen; i++) {
            const childPath = [...path, i];
            if (i >= a.length) added.add(pathKey(childPath));
            else if (i >= b.length) removed.add(pathKey(childPath));
            else {
                const sub = jsonDiffPaths(a[i], b[i], childPath);
                sub.changed.forEach((item) => changed.add(item));
                sub.added.forEach((item) => added.add(item));
                sub.removed.forEach((item) => removed.add(item));
            }
        }
        return { changed, added, removed };
    }
    for (const field of new Set([...Object.keys(a), ...Object.keys(b)])) {
        const childPath = [...path, field];
        if (!(field in a)) added.add(pathKey(childPath));
        else if (!(field in b)) removed.add(pathKey(childPath));
        else {
            const sub = jsonDiffPaths(a[field], b[field], childPath);
            sub.changed.forEach((item) => changed.add(item));
            sub.added.forEach((item) => added.add(item));
            sub.removed.forEach((item) => removed.add(item));
        }
    }
    return { changed, added, removed };
}

function normalizePreviewJson(value, maxDepth = 2, depth = 0) {
    if (depth >= maxDepth) return value;
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
            try {
                return normalizePreviewJson(JSON.parse(trimmed), maxDepth, depth + 1);
            } catch {}
        }
        return value;
    }
    if (Array.isArray(value)) return value.map((item) => normalizePreviewJson(item, maxDepth, depth + 1));
    if (value && typeof value === "object") {
        const out = {};
        for (const [key, item] of Object.entries(value)) out[key] = normalizePreviewJson(item, maxDepth, depth + 1);
        return out;
    }
    return value;
}

function isJsonLikeType(type) {
    return type === "object" || type === "array" || type === "json";
}

function parseFieldJson(value, type) {
    if (type === "json") return normalizePreviewJson(JSON.parse(value));
    if (type === "object" || type === "array") return normalizePreviewJson(value);
    return value;
}

function diffClassForPath(path, diff) {
    const key = pathKey(path);
    if (diff.added.has(key)) return "json-diff-added";
    if (diff.removed.has(key)) return "json-diff-removed";
    if (diff.changed.has(key)) return "json-diff-changed";
    return undefined;
}

function cloneJson(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function syncJsonEditorIndent(container) {
    // ponytail: jsoneditor sets inline marginLeft per level; strip it and let CSS nesting own indent
    container.querySelectorAll("table.jsoneditor-values").forEach((table) => {
        table.style.removeProperty("margin-left");
    });
}

function scheduleJsonEditorLayout(container) {
    requestAnimationFrame(() => syncJsonEditorIndent(container));
}

function expandableRowAtY(container, clientY) {
    let match;
    for (const row of container.querySelectorAll("tr.jsoneditor-expandable")) {
        const { top, bottom } = row.getBoundingClientRect();
        if (clientY >= top && clientY <= bottom) match = row;
    }
    return match;
}

function createJsonInspector(container) {
    if (typeof JSONEditor === "undefined") {
        const pre = document.createElement("pre");
        container.append(pre);
        return {
            set(json) { pre.textContent = JSON.stringify(json, null, 2); },
            update(json) { pre.textContent = JSON.stringify(json, null, 2); },
            destroy() { container.replaceChildren(); },
        };
    }
    let previousJson;
    let activeDiff = { changed: new Set(), added: new Set(), removed: new Set() };
    let fadeTimer;
    const editor = new JSONEditor(container, {
        mode: "view",
        timestampTag: false,
        colorPicker: false,
        mainMenuBar: false,
        navigationBar: false,
        statusBar: false,
        search: false,
        onClassName({ path }) {
            return diffClassForPath(path, activeDiff);
        },
    });
    container.addEventListener("click", (event) => {
        if (event.target.closest("a.jsoneditor-value")) return;
        const button = event.target.closest("button.jsoneditor-button");
        if (button) {
            button.blur();
            return;
        }
        let row = event.target.closest("tr.jsoneditor-expandable");
        if (!row && event.target.closest(".jsoneditor, .json-inspector")) {
            row = expandableRowAtY(container, event.clientY);
        }
        if (!row) return;
        const toggle = row.querySelector("button.jsoneditor-button:not(.jsoneditor-invisible)");
        if (!toggle) return;
        toggle.click();
        toggle.blur();
        scheduleJsonEditorLayout(container);
    }, true);
    const expandRoot = () => {
        try {
            editor.expand({ path: [], isExpand: true, recursive: false });
        } catch {}
    };
    return {
        set(json) {
            previousJson = cloneJson(json);
            activeDiff = { changed: new Set(), added: new Set(), removed: new Set() };
            editor.set(json);
            expandRoot();
            scheduleJsonEditorLayout(container);
        },
        update(json) {
            activeDiff = jsonDiffPaths(previousJson, json);
            editor.update(json);
            scheduleJsonEditorLayout(container);
            if (fadeTimer) clearTimeout(fadeTimer);
            fadeTimer = setTimeout(() => {
                activeDiff = { changed: new Set(), added: new Set(), removed: new Set() };
                editor.refresh();
                scheduleJsonEditorLayout(container);
                fadeTimer = null;
            }, 4000);
            previousJson = cloneJson(json);
        },
        destroy() {
            if (fadeTimer) clearTimeout(fadeTimer);
            editor.destroy();
            container.replaceChildren();
        },
    };
}

function resetInspectorViews() {
    inspectorViews.raw?.destroy();
    inspectorViews.raw = null;
    for (const entry of inspectorViews.fields.values()) entry.inspector?.destroy();
    inspectorViews.fields.clear();
    inspectorViews.soul = null;
}

function mountFieldJsonInspector(entry) {
    if (entry.inspector || !entry.mount) return;
    entry.inspector = createJsonInspector(entry.mount);
    entry.inspector.set(entry.pendingJson ?? entry.lastJson);
}

function buildFieldEntry(id, label, value, type, { collapsed = false } = {}) {
    const article = document.createElement("article");
    article.dataset.field = id;
    const name = document.createElement("strong");
    name.textContent = label;
    const badge = document.createElement("span");
    badge.textContent = type;
    if (!isJsonLikeType(type)) {
        const head = document.createElement("div");
        head.append(name, badge);
        article.append(head, valueElement(value, type));
        return { article, id, label, type, inspector: null, collapsed: false };
    }
    const parsed = parseFieldJson(value, type);
    if (collapsed) {
        const details = document.createElement("details");
        details.className = "inspector-group";
        const summary = document.createElement("summary");
        summary.append(name, badge);
        const mount = document.createElement("div");
        mount.className = "json-inspector json-inspector--field";
        details.append(summary, mount);
        article.append(details);
        const entry = { article, mount, inspector: null, lastJson: parsed, pendingJson: parsed, type, id, label, collapsed: true };
        details.addEventListener("toggle", () => {
            if (details.open) mountFieldJsonInspector(entry);
        });
        return entry;
    }
    const head = document.createElement("div");
    head.append(name, badge);
    const mount = document.createElement("div");
    mount.className = "json-inspector json-inspector--field";
    article.append(head, mount);
    const entry = { article, mount, inspector: null, lastJson: parsed, pendingJson: parsed, type, id, label, collapsed: false };
    mountFieldJsonInspector(entry);
    return entry;
}

function fieldGroupLabel(entry, label) {
    entry.label = label;
    const strong = entry.article.querySelector("strong");
    if (strong) strong.textContent = label;
}

function updateInspectorFields(data) {
    const fieldsEl = document.getElementById("inspectorFields");
    const groups = groupInspectorFields(data?.raw || {});
    const idSet = new Set(groups.map((group) => group.id));
    for (const [id, entry] of inspectorViews.fields) {
        if (!idSet.has(id)) {
            entry.inspector?.destroy();
            entry.article?.remove();
            inspectorViews.fields.delete(id);
        }
    }
    for (const group of groups) {
        const { id, label, value, collapsed = false } = group;
        const type = group.type || typeOfValue(value, id);
        let entry = inspectorViews.fields.get(id);
        if (!entry || entry.type !== type || entry.collapsed !== collapsed) {
            entry?.inspector?.destroy();
            entry?.article?.remove();
            entry = buildFieldEntry(id, label, value, type, { collapsed });
            inspectorViews.fields.set(id, entry);
        } else if (entry.label !== label) {
            fieldGroupLabel(entry, label);
        }
        if (isJsonLikeType(type)) {
            const parsed = parseFieldJson(value, type);
            entry.lastJson = parsed;
            entry.pendingJson = parsed;
            const details = entry.article.querySelector("details.inspector-group");
            if (entry.inspector) entry.inspector.update(parsed);
            else if (!details || details.open) mountFieldJsonInspector(entry);
        } else {
            const content = entry.collapsed
                ? null
                : entry.article.querySelector(":scope > :not(div)");
            const next = valueElement(value, type);
            content?.replaceWith(next);
        }
        fieldsEl.append(entry.article);
    }
}

function updateRawInspector(data, forceSet = false) {
    const container = document.getElementById("inspectorRaw");
    if (!data?.raw) {
        inspectorViews.raw?.destroy();
        inspectorViews.raw = null;
        container.replaceChildren();
        return;
    }
    const json = normalizePreviewJson(data.raw);
    if (!inspectorViews.raw || forceSet) {
        inspectorViews.raw?.destroy();
        inspectorViews.raw = createJsonInspector(container);
        inspectorViews.raw.set(json);
    } else {
        inspectorViews.raw.update(json);
    }
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
    const output = document.createElement(type === "text" ? "pre" : "span");
    output.textContent = value === null ? "null" : String(value);
    return output;
}

function renderInspector() {
    const empty = document.getElementById("inspectorEmpty");
    const content = document.getElementById("inspectorContent");
    document.querySelector(".explorer-inspector").classList.toggle("open", Boolean(state.selected));
    if (!state.selected) {
        resetInspectorViews();
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

    const fieldsEl = document.getElementById("inspectorFields");
    const soulChanged = state.selected !== inspectorViews.soul;
    if (soulChanged) {
        resetInspectorViews();
        inspectorViews.soul = state.selected;
        fieldsEl.replaceChildren();
        for (const group of groupInspectorFields(data?.raw || {})) {
            const type = group.type || typeOfValue(group.value, group.id);
            const entry = buildFieldEntry(group.id, group.label, group.value, type, { collapsed: group.collapsed });
            inspectorViews.fields.set(group.id, entry);
            fieldsEl.append(entry.article);
        }
        updateRawInspector(data, true);
        return;
    }
    updateInspectorFields(data);
    updateRawInspector(data);
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
    const el = document.getElementById("statusMessage");
    if (!el) return;
    el.textContent = message || [
        `${state.graph.nodes.filter((node) => !node.ghost && !node.exiting).length} stored nodes`,
        `${state.graph.edges.filter((edge) => !edge.exiting).length} references`,
        state.graph.nodes.some((node) => node.ghost && !node.exiting) ? `${state.graph.nodes.filter((node) => node.ghost && !node.exiting).length} missing targets` : "",
        state.graph.truncated ? `limited to ${MAX_NODES}` : "",
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
        const q = state.query;
        const depth = q ? 1 : 0;
        const qParam = q ? `&q=${encodeURIComponent(q)}` : "";
        const graphPath = `/api/graph/subgraph?maxNodes=${MAX_NODES}&depth=${depth}&list=${LIST_LIMIT}${qParam}`;
        // A full load covers anything queued for a live patch.
        pendingLiveSouls.clear();
        const liveOpen = liveSocket?.readyState === WebSocket.OPEN;
        const [graph, stats] = await Promise.all([
            api(graphPath),
            liveOpen ? null : api("/api/stats"),
        ]);
        // ponytail: older peers ignore `list`; only they cost a second listing call.
        const souls = graph.souls
            ? { souls: graph.souls }
            : await api(`/api/graph/souls?limit=${LIST_LIMIT}&sort=updated${qParam}`);
        lastFullLoad = Date.now();
        state.rows = souls.souls || [];
        const selectedExists = !state.selected || graph.nodes.some((node) => node.soul === state.selected);
        state.graph = prepareGraph(graph, state.ready ? state.graph : undefined, state.ready);
        if (!state.ready) settleGraph(state.graph);
        if (stats) {
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
        restartSimulation(quiet ? 0 : 1);
        if (fit || !state.ready || q) fitGraph();
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
    if (liveSocket) {
        liveSocket.close();
        liveSocket = null;
    }
    const socket = new WebSocket(peerGunWsUrl());
    liveSocket = socket;
    socket.addEventListener("open", () => {
        liveReconnectDelay = LIVE_RECONNECT_MIN_MS;
        document.getElementById("peerStatus").textContent = "live";
        document.getElementById("peerStatus").className = "explorer-peer online";
    });
    socket.addEventListener("message", (event) => {
        try {
            const messages = JSON.parse(event.data);
            for (const message of Array.isArray(messages) ? messages : [messages]) {
                if (!message?.put || typeof message.put !== "object") continue;
                for (const soul of Object.keys(message.put)) {
                    // Past the cap a full reload happens anyway, so stop growing the set.
                    if (pendingLiveSouls.size > LIVE_PATCH_MAX_SOULS) break;
                    pendingLiveSouls.add(soul);
                }
            }
            scheduleLivePatch();
        } catch {}
    });
    socket.addEventListener("close", () => {
        // Only the current socket reconnects; a socket we replaced must not restart the loop.
        if (liveSocket !== socket) return;
        document.getElementById("peerStatus").textContent = "reconnecting";
        document.getElementById("peerStatus").className = "explorer-peer";
        liveTimer = setTimeout(connectLive, liveReconnectDelay);
        liveReconnectDelay = Math.min(liveReconnectDelay * 2, LIVE_RECONNECT_MAX_MS);
    });
    socket.addEventListener("error", () => socket.close());
}

function scheduleLivePatch() {
    if (!pendingLiveSouls.size || liveRefreshTimer || document.hidden) return;
    liveRefreshTimer = setTimeout(() => {
        liveRefreshTimer = null;
        applyLivePatch();
    }, Math.max(90, LIVE_PATCH_MS - (Date.now() - lastLiveRefresh)));
}

async function applyLivePatch() {
    if (state.loading || !state.ready) {
        scheduleLivePatch();
        return;
    }
    const souls = [...pendingLiveSouls];
    pendingLiveSouls.clear();
    lastLiveRefresh = Date.now();
    if (!souls.length) return;
    if (souls.length > LIVE_PATCH_MAX_SOULS || souls.some((soul) => soul.includes(","))) {
        loadGraph({ quiet: true });
        return;
    }

    let patch;
    try {
        patch = await api(`/api/graph/subgraph?roots=${souls.map(encodeURIComponent).join(",")}&depth=0&maxNodes=500`);
    } catch {
        return;
    }
    if (state.loading) return;
    const merged = mergeLivePatch(state.graph, state.rows, patch, souls, !state.query);
    if (!merged) {
        loadGraph({ quiet: true });
        return;
    }
    state.rows = merged.rows;
    state.graph = prepareGraph(merged, state.graph, true);
    if (state.selected && souls.includes(state.selected)) {
        if (merged.nodes.some((node) => node.soul === state.selected && !node.ghost)) {
            state.inspector = await api(`/api/graph/node?soul=${encodeURIComponent(state.selected)}`).catch(() => state.inspector);
        } else {
            state.selected = null;
            state.inspector = null;
        }
    }
    renderList();
    renderInspector();
    restartSimulation(0);
    renderStatus();
}

async function fetchPeerGraph() {
    const input = document.getElementById("peerUrlInput");
    const msg = document.getElementById("peerUrlMsg");
    const normalized = normalizePeerUrlInput(input?.value || "");
    if (!normalized.ok) {
        msg.textContent = normalized.error;
        return;
    }

    msg.textContent = "validating peer…";
    try {
        const gunUrl = normalized.url;
        const isLocal = new URL(gunUrl).origin === location.origin;
        if (!isLocal) {
            await verifyGunPeer(gunUrl);
        }
        setActivePeer(isLocal ? null : gunUrl);
        input.value = gunUrl;
        msg.textContent = "loading graph…";
        clearSelection();
        connectLive();
        await loadGraph({ quiet: true });
        msg.textContent = "";
        document.getElementById("peerUrlForm").hidden = true;
        document.getElementById("peerUrlToggle").setAttribute("aria-expanded", "false");
        document.querySelector(".peer-url-chevron").textContent = "<";
    } catch (error) {
        msg.textContent = error.message;
    }
}

function initPeerUrlPanel() {
    const toggle = document.getElementById("peerUrlToggle");
    const form = document.getElementById("peerUrlForm");
    const chevron = document.querySelector(".peer-url-chevron");
    if (!toggle || !form) return;

    toggle.addEventListener("click", () => {
        const open = toggle.getAttribute("aria-expanded") === "true";
        toggle.setAttribute("aria-expanded", open ? "false" : "true");
        form.hidden = open;
        if (chevron) chevron.textContent = open ? "<" : ">";
        if (!open) document.getElementById("peerUrlMsg").textContent = "";
    });

    document.getElementById("peerUrlFetch")?.addEventListener("click", fetchPeerGraph);
    document.getElementById("peerUrlInput")?.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            fetchPeerGraph();
        }
    });
}

const PANEL_STATE_KEY = "explorer-panels";

function loadPanelState() {
    try {
        const raw = localStorage.getItem(PANEL_STATE_KEY);
        if (!raw) return null;
        const data = JSON.parse(raw);
        return {
            sidebar: data.sidebar !== false,
            inspector: data.inspector !== false,
        };
    } catch {
        return null;
    }
}

function savePanelState(sidebarOpen, inspectorOpen) {
    try {
        localStorage.setItem(PANEL_STATE_KEY, JSON.stringify({ sidebar: sidebarOpen, inspector: inspectorOpen }));
    } catch {
        // ponytail: private mode / quota — ignore
    }
}

function initPanelToggles() {
    const main = document.querySelector(".explorer-main");
    const sidebar = document.getElementById("explorerSidebar");
    const inspector = document.getElementById("explorerInspector");
    const sidebarInner = sidebar?.querySelector(".explorer-sidebar-inner");
    const inspectorInner = inspector?.querySelector(".explorer-inspector-inner");
    const sidebarBtn = document.getElementById("toggleSidebarBtn");
    const inspectorBtn = document.getElementById("toggleInspectorBtn");
    const scrim = document.getElementById("panelScrim");
    const narrow = window.matchMedia("(max-width: 850px)");
    if (!main || !sidebar || !inspector || !sidebarInner || !inspectorInner || !sidebarBtn || !inspectorBtn) return;

    const saved = loadPanelState();
    let sidebarOpen = saved?.sidebar ?? false;
    let inspectorOpen = saved?.inspector ?? false;

    function applyPanels() {
        main.classList.toggle("sidebar-hidden", !sidebarOpen);
        main.classList.toggle("inspector-hidden", !inspectorOpen);
        const panelsOpen = narrow.matches && (sidebarOpen || inspectorOpen);
        main.classList.toggle("panels-open", panelsOpen);
        if (scrim) {
            scrim.hidden = !panelsOpen;
            scrim.setAttribute("aria-hidden", String(!panelsOpen));
        }
        sidebarBtn.setAttribute("aria-pressed", String(sidebarOpen));
        inspectorBtn.setAttribute("aria-pressed", String(inspectorOpen));
        sidebarBtn.setAttribute("aria-expanded", String(sidebarOpen));
        inspectorBtn.setAttribute("aria-expanded", String(inspectorOpen));
        sidebarInner.toggleAttribute("inert", !sidebarOpen);
        inspectorInner.toggleAttribute("inert", !inspectorOpen);
        sidebarInner.setAttribute("aria-hidden", String(!sidebarOpen));
        inspectorInner.setAttribute("aria-hidden", String(!inspectorOpen));
        savePanelState(sidebarOpen, inspectorOpen);
        requestAnimationFrame(() => {
            resize();
            if (state.ready) fitGraph();
        });
    }

    sidebarBtn.addEventListener("click", () => {
        sidebarOpen = !sidebarOpen;
        if (sidebarOpen && narrow.matches) inspectorOpen = false;
        if (!sidebarOpen && sidebarInner.contains(document.activeElement)) canvas.focus();
        applyPanels();
    });
    inspectorBtn.addEventListener("click", () => {
        inspectorOpen = !inspectorOpen;
        if (inspectorOpen && narrow.matches) sidebarOpen = false;
        if (!inspectorOpen && inspectorInner.contains(document.activeElement)) canvas.focus();
        applyPanels();
    });
    scrim?.addEventListener("click", () => {
        sidebarOpen = false;
        inspectorOpen = false;
        canvas.focus();
        applyPanels();
    });
    narrow.addEventListener("change", applyPanels);
    applyPanels();
}

function init() {
    canvas = document.getElementById("graphCanvas");
    ctx = canvas.getContext("2d");
    bindCanvas();
    const stage = canvas.parentElement;
    let resizeFitTimer;
    if (stage) {
        new ResizeObserver(() => {
            resize();
            if (!state.ready) return;
            clearTimeout(resizeFitTimer);
            resizeFitTimer = setTimeout(fitGraph, 100);
        }).observe(stage);
    }
    document.getElementById("fitBtn").addEventListener("click", fitGraph);
    document.getElementById("refreshBtn").addEventListener("click", () => loadGraph());
    document.getElementById("searchInput").addEventListener("input", (event) => {
        state.query = event.target.value.trim().toLowerCase();
        renderList();
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => loadGraph({ fit: true, quiet: true }), 250);
    });
    document.getElementById("copySoulBtn").addEventListener("click", async (event) => {
        await navigator.clipboard.writeText(state.selected);
        event.target.textContent = "copied";
        setTimeout(() => { event.target.textContent = "copy soul"; }, 1000);
    });
    document.getElementById("closeInspectorBtn").addEventListener("click", clearSelection);
    initPanelToggles();
    initPeerUrlPanel();
    requestAnimationFrame(() => {
        resize();
        loadGraph({ fit: true });
    });
    connectLive();
    // ponytail: live puts are patched in place; this slow pass only catches eviction and missed messages.
    setInterval(() => {
        if (!document.hidden) loadGraph({ quiet: true });
    }, FULL_REFRESH_MS);
    document.addEventListener("visibilitychange", () => {
        if (document.hidden) return;
        if (Date.now() - lastFullLoad > STALE_ON_SHOW_MS) loadGraph({ quiet: true });
        else scheduleLivePatch();
    });
}

if (typeof document !== "undefined") init();

export { gridStep, jsonDiffPaths, mergeLivePatch, normalizePreviewJson, prepareGraph, previewValue, settleGraph, typeOfValue };
