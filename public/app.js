const GRAPH_MAX_POINTS = 60;
const GRAPH_SAMPLE_MS = 5000;
const GRAPH_WINDOW_MS = GRAPH_MAX_POINTS * GRAPH_SAMPLE_MS;

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

const STAGE_LABELS = {
    'explorer-paused': 'explorer and housekeeping pause',
    'writes-paused': 'writes to stored data pause',
    'reads-paused': 'uncached reads of stored data pause',
};

function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

function formatPercent(fraction) {
    if (!(fraction > 0)) return '0%';
    if (fraction < 0.01) return '<1%';
    return `${Math.min(100, Math.round(fraction * 100))}%`;
}

// Tick marks on a meter, e.g. the budget stages or the storage cleanup point.
function setMeterTicks(meter, fractions) {
    const key = fractions.join(',');
    if (meter.dataset.ticks === key) return;
    meter.dataset.ticks = key;
    meter.querySelectorAll('.meter-tick').forEach((t) => t.remove());
    for (const f of fractions) {
        const tick = document.createElement('i');
        tick.className = 'meter-tick';
        tick.style.left = `${f * 100}%`;
        meter.appendChild(tick);
    }
}

function setMeter(id, fraction, { ticks = [], warnAt = Infinity, dangerAt = Infinity } = {}) {
    const meter = document.getElementById(id);
    const fill = meter?.querySelector('.storage-meter__fill');
    if (!fill) return;
    const pct = Math.max(0, Math.min(100, fraction * 100));
    // a sliver for any non-zero usage, so "in use" never reads as empty
    fill.style.width = `${fraction > 0 ? Math.max(pct, 0.5) : 0}%`;
    fill.classList.toggle('is-warn', fraction >= warnAt && fraction < dangerAt);
    fill.classList.toggle('is-danger', fraction >= dangerAt);
    meter.setAttribute('aria-valuenow', String(Math.round(pct)));
    setMeterTicks(meter, ticks);
}

function updateRowMeter(prefix, used, limit, stages) {
    setText(`${prefix}Today`, used != null ? used.toLocaleString('en-US') : '0');
    setText(`${prefix}Limit`, limit ? ` / ${limit.toLocaleString('en-US')}` : '');
    setText(`${prefix}Percent`, limit ? formatPercent(used / limit) : '');
    setMeter(`${prefix}Meter`, limit ? used / limit : 0, {
        ticks: (stages || []).map((s) => s.at),
        warnAt: stages?.[0]?.at ?? 0.5,
        dangerAt: stages?.[1]?.at ?? 0.8,
    });
}

function renderBudgetStages(stages, fraction) {
    const list = document.getElementById('budgetStages');
    if (!list || !stages?.length) return;
    const key = JSON.stringify(stages);
    if (list.dataset.key !== key) {
        list.dataset.key = key;
        list.replaceChildren(...stages.map((s) => {
            const li = document.createElement('li');
            li.dataset.at = String(s.at);
            const at = document.createElement('span');
            at.className = 'threshold-at';
            at.textContent = `${Math.round(s.at * 100)}%`;
            const label = document.createElement('span');
            label.textContent = STAGE_LABELS[s.name] || s.name.replace(/-/g, ' ');
            li.append(at, label);
            return li;
        }));
    }
    list.querySelectorAll('li').forEach((li) => {
        li.classList.toggle('is-reached', fraction >= Number(li.dataset.at));
    });
}

function updateBudget(storage) {
    const budget = storage.budget;
    if (!budget) return;
    updateRowMeter('rowsRead', budget.rowsRead, budget.limits?.rowsRead, budget.stages);
    updateRowMeter('rowsWritten', budget.rowsWritten, budget.limits?.rowsWritten, budget.stages);
    renderBudgetStages(budget.stages, budget.fraction ?? 0);
    const blocked = storage.health && storage.health.ready === false;
    const paused = blocked || budget.stage !== 'ok';
    const stage = document.getElementById('budgetStage');
    if (stage) {
        stage.textContent = blocked ? 'storage blocked' : budget.stage.replace(/-/g, ' ');
        stage.classList.toggle('is-paused', paused);
    }
    const at = budget.resetsAt ? new Date(budget.resetsAt) : null;
    setText('budgetResets', at ? `resets ${at.toISOString().slice(11, 16)} UTC` : '');
    const note = document.getElementById('budgetNote');
    if (note && budget.limits) {
        note.textContent =
            `Free tier allows ${budget.limits.rowsRead.toLocaleString('en-US')} rows read and ${budget.limits.rowsWritten.toLocaleString('en-US')} rows written per UTC day. ` +
            'Live cursors and presence stay in memory and cost no rows. ' +
            (blocked ? `Storage is blocked right now (${storage.health.error || 'quota'}); live data keeps relaying. ` : '') +
            'Whichever counter is further along decides what pauses:';
    }
}

function updateStorage(storage) {
    const used = storage.bytesUsed;
    const limit = storage.limitBytes;
    const evictAt = storage.evictAtBytes;
    setText('storageUsed', used != null ? formatBytes(used) : 'unknown');
    setText('storageLimitInline', limit ? ` / ${formatBytes(limit)}` : '');
    setText('storagePercent', used != null && limit ? formatPercent(used / limit) : '');
    if (limit) setText('storageLimit', formatBytes(limit));
    setText('storageEvictAt', evictAt ? formatBytes(evictAt) : '-');
    setText('storageEvictBytes', storage.evictBytes ? `~${formatBytes(storage.evictBytes)} oldest` : '-');
    setText('storageBackend', storage.backend || 'durable-object-sqlite');
    setMeter('storageMeter', used != null && limit ? used / limit : 0, {
        ticks: evictAt && limit ? [evictAt / limit] : [],
    });
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
        }

        if (data.storage) {
            setText('graphNodes', data.storage.graphNodes != null ? data.storage.graphNodes.toLocaleString('en-US') : '0');
            setText('liveNodes', data.storage.liveNodes != null ? data.storage.liveNodes.toLocaleString('en-US') : '0');
            updateBudget(data.storage);
            updateStorage(data.storage);
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

    let statsTimer = null;
    const startStatsPolling = () => {
        if (statsTimer != null) return;
        fetchStats();
        statsTimer = setInterval(fetchStats, GRAPH_SAMPLE_MS);
    };
    const stopStatsPolling = () => {
        if (statsTimer == null) return;
        clearInterval(statsTimer);
        statsTimer = null;
    };

    startStatsPolling();

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            stopStatsPolling();
        } else {
            startStatsPolling();
        }
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

// ponytail: self-check time-based graph x (5-minute window at 5s samples)
if (typeof console !== 'undefined' && console.assert) {
    const w = 600;
    const now = 100_000;
    const windowMs = 300_000;
    console.assert(sampleX(now - 150_000, now, windowMs, w) === w / 2, 'mid-window sample at 50%');
    console.assert(sampleX(now, now, windowMs, w) === w, 'now at right edge');
    console.assert(sampleX(now - 300_000, now, windowMs, w) === 0, 'oldest at left edge');
    console.assert(graphScale([0, 0, 0]) === 1, 'all-zero scale should be 1');
}
