// History tracking
const history = {
    messages: [],
    bytes: [],
    maxPoints: 60,
    lastMessages: null,
    lastBytes: null,
    lastTime: null
};

// Format bytes to human readable
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Format numbers
function formatNumber(num) {
    return num.toString();
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

// Scale canvas for device pixel ratio
function setupCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
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

function drawSeries(ctx, data, xStep, baselineY, plotH, yMax, strokeStyle) {
    if (data.length < 2) return;
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
        const x = i * xStep;
        const y = baselineY - (data[i] / yMax) * plotH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.stroke();
}

// Dual-series throughput graph — each series uses its own Y scale
function drawThroughputGraph(canvasId, messages, bytes) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    const { ctx, width, height } = setupCanvas(canvas);
    const pad = 5;
    const labelH = 28;
    const plotTop = pad + labelH;
    const plotH = height - plotTop - pad;
    const baselineY = height - pad;

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);

    const msgVisible = messages.slice(-history.maxPoints);
    const byteVisible = bytes.slice(-history.maxPoints);
    const pointCount = Math.max(msgVisible.length, byteVisible.length);

    if (pointCount < 1) {
        ctx.fillStyle = '#666';
        ctx.font = '10px monospace';
        ctx.fillText('0.0 msg/s · 0 B/s', pad, 15);
        return;
    }

    const msgMax = graphScale(msgVisible);
    const byteMax = graphScale(byteVisible);
    const xStep = width / (history.maxPoints - 1);
    const nowX = (pointCount - 1) * xStep;

    ctx.strokeStyle = '#222';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, baselineY);
    ctx.lineTo(width, baselineY);
    ctx.stroke();

    if (pointCount < history.maxPoints) {
        ctx.strokeStyle = '#333';
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(nowX, plotTop);
        ctx.lineTo(nowX, baselineY);
        ctx.stroke();
        ctx.setLineDash([]);
    }

    drawSeries(ctx, msgVisible, xStep, baselineY, plotH, msgMax, '#fff');
    drawSeries(ctx, byteVisible, xStep, baselineY, plotH, byteMax, '#666');

    const msgAvg = rollingAverage(msgVisible);
    const byteAvg = rollingAverage(byteVisible);
    ctx.font = '10px monospace';
    ctx.fillStyle = '#fff';
    ctx.fillText(formatNumberSmart(msgAvg) + ' msg/s avg', pad, 15);
    ctx.fillStyle = '#666';
    ctx.fillText(formatBytes(byteAvg) + '/s avg', pad, 28);
}

// Update stats display
function updateStats(data) {
    try {
        const statusText = document.getElementById('statusText');

        if (data.status === 'online') {
            statusText.classList.add('online');
            statusText.textContent = 'online';
        } else {
            statusText.classList.remove('online');
            statusText.textContent = 'offline';
        }

        // Uptime
        if (data.uptime) {
            const u = data.uptime;
            document.getElementById('uptimeDetail').textContent =
                `${u.days}d ${u.hours % 24}h ${u.minutes % 60}m ${u.seconds % 60}s`;
        }

        // Live connected clients
        if (data.connections) {
            const live = data.connections.live ?? data.connections.current ?? 0;
            document.getElementById('liveClients').textContent = live;
            document.getElementById('totalConnections').textContent = data.connections.total;
            document.getElementById('liveClientsBlock').classList.toggle('active', live > 0);
        }

        // Storage
        if (data.storage) {
            const used = data.storage.bytesUsed;
            document.getElementById('storageUsed').textContent =
                used != null ? formatBytes(used) : 'unknown';
            document.getElementById('storageBackend').textContent =
                data.storage.backend || 'sqlite';
            document.getElementById('graphNodes').textContent =
                data.storage.graphNodes != null ? data.storage.graphNodes : '0';
            if (data.storage.limitBytes) {
                document.getElementById('storageLimit').textContent =
                    formatBytes(data.storage.limitBytes);
            }
        }

        // Performance - calculate rates
        if (data.performance) {
            const now = Date.now();
            const perf = data.performance;

            // First sample seeds counters — avoids one giant rate from server totals
            if (history.lastTime === null) {
                history.lastMessages = perf.messagesProcessed;
                history.lastBytes = perf.bytesTransferred;
                history.lastTime = now;
            } else {
                const timeDiff = (now - history.lastTime) / 1000;
                // ponytail: gap > 2 min → reseed; avoids one flat or averaged point after idle
                if (timeDiff > 120) {
                    history.lastMessages = perf.messagesProcessed;
                    history.lastBytes = perf.bytesTransferred;
                    history.lastTime = now;
                } else if (timeDiff > 0) {
                    const msgRate = (perf.messagesProcessed - history.lastMessages) / timeDiff;
                    const byteRate = (perf.bytesTransferred - history.lastBytes) / timeDiff;

                    history.messages.push(msgRate);
                    history.bytes.push(byteRate);

                    if (history.messages.length > history.maxPoints) {
                        history.messages.shift();
                        history.bytes.shift();
                    }

                    history.lastMessages = perf.messagesProcessed;
                    history.lastBytes = perf.bytesTransferred;
                    history.lastTime = now;
                }
            }

            drawThroughputGraph('throughputGraph', history.messages, history.bytes);
        }

        // Last updated
        document.getElementById('lastUpdated').textContent = formatTime(Date.now());

    } catch (error) {
        console.error('Error updating stats:', error);
    }
}

// Fetch stats from API
async function fetchStats() {
    try {
        const response = await fetch('/api/stats');
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const data = await response.json();
        updateStats(data);
    } catch (error) {
        console.error('Error fetching stats:', error);
        const statusText = document.getElementById('statusText');
        statusText.classList.remove('online');
        statusText.textContent = 'error';
    }
}

// Initialize
function init() {
    fetchStats();
    setInterval(fetchStats, 1000);

    window.addEventListener('resize', () => {
        drawThroughputGraph('throughputGraph', history.messages, history.bytes);
    });

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) fetchStats();
    });
}

// Start
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

window.addEventListener('online', fetchStats);
window.addEventListener('offline', () => {
    const statusText = document.getElementById('statusText');
    statusText.classList.remove('online');
    statusText.textContent = 'offline';
});

// ponytail: self-check graph slot math
if (typeof console !== 'undefined' && console.assert) {
    const slots = history.maxPoints;
    const w = 580;
    const step = w / (slots - 1);
    console.assert(Math.abs((slots - 1) * step - w) < 0.01, 'graph x slots should span full width');
    console.assert(graphScale([0, 0, 0]) === 1, 'all-zero scale should be 1');
    console.assert(graphScale([10, 2, 0]) === 11.5, 'scale should add 15% headroom');
}
