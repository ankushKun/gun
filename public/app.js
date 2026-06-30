const GRAPH_MAX_POINTS = 60;
const GRAPH_WINDOW_MS = GRAPH_MAX_POINTS * 1000;

// Format bytes to human readable
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Format time
function formatTime(date) {
    const d = new Date(date);
    return d.toTimeString().split(' ')[0];
}

// Format numbers with K suffix
function formatNumberSmart(num) {
    if (num >= 1000) {
        return (num / 1000).toFixed(1) + 'K';
    }
    return num.toFixed(1);
}

const canvasLayout = new WeakMap();

function setupCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.floor(rect.width);
    const h = Math.floor(rect.height);
    const prev = canvasLayout.get(canvas);

    if (!prev || prev.w !== w || prev.h !== h || prev.dpr !== dpr) {
        canvas.width = Math.max(1, w * dpr);
        canvas.height = Math.max(1, h * dpr);
        canvasLayout.set(canvas, { w, h, dpr });
    }

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, width: w, height: h };
}

function graphScale(values) {
    const peak = Math.max(...values, 0);
    if (peak === 0) return 1;
    return peak * 1.15;
}

function rollingAverage(values, window = 5) {
    const slice = values.slice(-window);
    if (!slice.length) return 0;
    return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function sampleX(t, now, windowMs, width) {
    const start = now - windowMs;
    return Math.max(0, Math.min(width, ((t - start) / windowMs) * width));
}

function drawTimeSeries(ctx, samples, valueKey, baselineY, plotH, yMax, strokeStyle, now, windowMs, width) {
    if (!samples.length) return;

    if (samples.length === 1) {
        const x = sampleX(samples[0].t, now, windowMs, width);
        const y = baselineY - (samples[0][valueKey] / yMax) * plotH;
        ctx.fillStyle = strokeStyle;
        ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
        return;
    }

    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < samples.length; i++) {
        const x = sampleX(samples[i].t, now, windowMs, width);
        const y = baselineY - (samples[i][valueKey] / yMax) * plotH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.stroke();
}

function graphPalette(status) {
    const v = window.themeVar || (() => '');
    return {
        online: { msg: v('graph-msg'), byte: v('graph-byte') },
        error: { msg: v('error'), byte: v('error-dim') },
        offline: { msg: v('text-muted'), byte: v('text-faint') },
    }[status] || { msg: v('text-muted'), byte: v('text-faint') };
}

function drawThroughputGraph(canvasId, samples, windowMs = GRAPH_WINDOW_MS) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    const { ctx, width, height } = setupCanvas(canvas);
    const pad = 5;
    const labelH = 28;
    const plotTop = pad + labelH;
    const plotH = height - plotTop - pad;
    const baselineY = height - pad;
    const now = Date.now();
    const v = window.themeVar || (() => '');

    ctx.fillStyle = v('graph-bg') || '#032221';
    ctx.fillRect(0, 0, width, height);

    const visible = samples.filter((s) => s.t >= now - windowMs);
    const colors = graphPalette(graphStatus);

    if (!visible.length) {
        ctx.font = '10px monospace';
        ctx.fillStyle = colors.msg;
        ctx.fillText('0.0 msg/s · 0 B/s', pad, 15);
        return;
    }

    const msgValues = visible.map((s) => s.msg);
    const byteValues = visible.map((s) => s.byte);
    const msgMax = graphScale(msgValues);
    const byteMax = graphScale(byteValues);

    ctx.strokeStyle = v('graph-line') || '#0f4a40';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, baselineY);
    ctx.lineTo(width, baselineY);
    ctx.stroke();

    drawTimeSeries(ctx, visible, 'byte', baselineY, plotH, byteMax, colors.byte, now, windowMs, width);
    drawTimeSeries(ctx, visible, 'msg', baselineY, plotH, msgMax, colors.msg, now, windowMs, width);

    ctx.font = '10px monospace';
    ctx.fillStyle = colors.msg;
    ctx.fillText(formatNumberSmart(rollingAverage(msgValues)) + ' msg/s avg', pad, 15);
    ctx.fillStyle = colors.byte;
    ctx.fillText(formatBytes(rollingAverage(byteValues)) + '/s avg', pad, 28);
}

let lastGraph = { samples: [], windowMs: GRAPH_WINDOW_MS };
let graphStatus = 'offline';

function redrawThroughputGraph(samples, windowMs = GRAPH_WINDOW_MS) {
    lastGraph = { samples, windowMs };
    drawThroughputGraph('throughputGraph', samples, windowMs);
}

function setStatusLatency(ms) {
    const el = document.getElementById('statusLatency');
    if (!el) return;
    el.classList.remove('is-warn', 'is-slow');
    if (ms == null) {
        el.textContent = '';
        return;
    }
    el.textContent = `[${String(ms).padStart(3, '_')}ms]`;
    if (ms > 500) el.classList.add('is-slow');
    else if (ms > 200) el.classList.add('is-warn');
}

function updateStorageMeter(used, limit) {
    const fill = document.getElementById('storageMeterFill');
    const percent = document.getElementById('storagePercent');
    const meter = document.querySelector('.storage-meter');
    if (!fill || !percent || used == null || !limit) {
        if (fill) fill.style.width = '0%';
        if (percent) percent.textContent = '';
        if (meter) meter.setAttribute('aria-valuenow', '0');
        return;
    }
    const pct = Math.min(100, Math.round((used / limit) * 100));
    fill.style.width = `${pct}%`;
    percent.textContent = `${pct}% of limit`;
    meter.setAttribute('aria-valuenow', String(pct));
}

// Update stats display
function updateStats(data, latencyMs) {
    try {
        const statusChip = document.getElementById('statusChip');
        const statusText = document.getElementById('statusText');

        if (data.status === 'online') {
            statusChip.classList.add('active');
            statusText.classList.remove('error');
            statusText.textContent = 'online';
            setStatusLatency(latencyMs);
            graphStatus = 'online';
        } else {
            statusChip.classList.remove('active');
            statusText.classList.remove('error');
            statusText.textContent = 'offline';
            setStatusLatency(null);
            graphStatus = 'offline';
        }

        if (data.uptime) {
            const u = data.uptime;
            document.getElementById('uptimeDetail').textContent =
                `${u.days}d ${u.hours % 24}h ${u.minutes % 60}m ${u.seconds % 60}s`;
        }

        if (data.connections) {
            const live = data.connections.live ?? data.connections.current ?? 0;
            document.getElementById('liveClients').textContent = live;
            document.getElementById('totalConnections').textContent = data.connections.total;
        }

        if (data.storage) {
            const used = data.storage.bytesUsed;
            const limit = data.storage.limitBytes;
            document.getElementById('storageUsed').textContent =
                used != null ? formatBytes(used) : 'unknown';
            document.getElementById('storageBackend').textContent =
                data.storage.backend || 'durable-object-sqlite';
            document.getElementById('graphNodes').textContent =
                data.storage.graphNodes != null ? data.storage.graphNodes : '0';
            if (limit) {
                document.getElementById('storageLimit').textContent = formatBytes(limit);
            }
            updateStorageMeter(used, limit);
            const note = document.getElementById('storageEvictionNote');
            const evictAt = data.storage.evictAtBytes;
            const evictBytes = data.storage.evictBytes;
            if (note && evictAt && evictBytes) {
                note.textContent =
                    `When usage nears ${formatBytes(evictAt)}, about ${formatBytes(evictBytes)} of the oldest graph data is cleared automatically to make room for new data.`;
            }
        }

        if (data.throughput?.samples) {
            redrawThroughputGraph(
                data.throughput.samples,
                data.throughput.windowMs || GRAPH_WINDOW_MS
            );
        }

        if (data.mesh && window.renderMeshStatus) {
            window.renderMeshStatus(data.mesh);
        }

        document.getElementById('lastUpdated').textContent = formatTime(Date.now());

    } catch (error) {
        console.error('Error updating stats:', error);
    }
}

async function fetchStats() {
    const t0 = performance.now();
    try {
        const response = await fetch('/api/stats');
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const data = await response.json();
        const latencyMs = Math.round(performance.now() - t0);
        updateStats(data, latencyMs);
    } catch (error) {
        console.error('Error fetching stats:', error);
        const statusChip = document.getElementById('statusChip');
        const statusText = document.getElementById('statusText');
        statusChip.classList.remove('active');
        statusText.classList.add('error');
        statusText.textContent = 'error';
        setStatusLatency(null);
        graphStatus = 'error';
        redrawThroughputGraph(lastGraph.samples, lastGraph.windowMs);
    }
}

function init() {
    const canvas = document.getElementById('throughputGraph');
    if (canvas && typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => {
            redrawThroughputGraph(lastGraph.samples, lastGraph.windowMs);
        });
        ro.observe(canvas);
    }

    fetchStats();
    setInterval(fetchStats, 1000);

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) fetchStats();
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

window.addEventListener('online', fetchStats);
window.addEventListener('offline', () => {
    const statusChip = document.getElementById('statusChip');
    const statusText = document.getElementById('statusText');
    statusChip.classList.remove('active');
    statusText.classList.remove('error');
    statusText.textContent = 'offline';
    setStatusLatency(null);
    graphStatus = 'offline';
    redrawThroughputGraph(lastGraph.samples, lastGraph.windowMs);
});

// ponytail: self-check time-based graph x
if (typeof console !== 'undefined' && console.assert) {
    const w = 600;
    const now = 100_000;
    const windowMs = 60_000;
    console.assert(sampleX(now - 30_000, now, windowMs, w) === w / 2, 'mid-window sample at 50%');
    console.assert(sampleX(now, now, windowMs, w) === w, 'now at right edge');
    console.assert(sampleX(now - 60_000, now, windowMs, w) === 0, 'oldest at left edge');
    console.assert(graphScale([0, 0, 0]) === 1, 'all-zero scale should be 1');
}
