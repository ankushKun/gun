// History tracking
const history = {
    messages: [],
    bytes: [],
    maxPoints: 60,
    lastMessages: 0,
    lastBytes: 0,
    lastTime: Date.now()
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

// Draw graph
function drawGraph(canvasId, data, label, isBytes = false) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;

    // Clear
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);

    if (data.length < 2) return;

    // Find max value for scaling
    const max = Math.max(...data, 1);

    // Draw line
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.beginPath();

    const step = width / (history.maxPoints - 1);
    const startIdx = Math.max(0, data.length - history.maxPoints);

    for (let i = 0; i < data.length - startIdx; i++) {
        const x = i * step;
        const y = height - (data[startIdx + i] / max * (height - 10)) - 5;

        if (i === 0) {
            ctx.moveTo(x, y);
        } else {
            ctx.lineTo(x, y);
        }
    }

    ctx.stroke();

    // Draw current value
    ctx.fillStyle = '#666';
    ctx.font = '10px monospace';
    const current = data[data.length - 1] || 0;
    let displayValue;
    if (isBytes) {
        displayValue = formatBytes(current) + '/s';
    } else {
        displayValue = formatNumberSmart(current) + ' ' + label;
    }
    ctx.fillText(displayValue, 5, 15);
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

        // Connections
        if (data.connections) {
            document.getElementById('currentConnections').textContent = data.connections.current;
            document.getElementById('totalConnections').textContent = data.connections.total;
            document.getElementById('activePeers').textContent = data.connections.activePeers;
        }

        // Performance - calculate rates
        if (data.performance) {
            const now = Date.now();
            const timeDiff = (now - history.lastTime) / 1000; // seconds

            // Calculate per-second rates
            const msgDiff = data.performance.messagesProcessed - history.lastMessages;
            const byteDiff = data.performance.bytesTransferred - history.lastBytes;

            const msgRate = timeDiff > 0 ? msgDiff / timeDiff : 0;
            const byteRate = timeDiff > 0 ? byteDiff / timeDiff : 0;

            // Update history
            history.messages.push(msgRate);
            history.bytes.push(byteRate);

            if (history.messages.length > history.maxPoints) {
                history.messages.shift();
                history.bytes.shift();
            }

            // Update tracking
            history.lastMessages = data.performance.messagesProcessed;
            history.lastBytes = data.performance.bytesTransferred;
            history.lastTime = now;

            // Draw graphs
            drawGraph('messagesGraph', history.messages, 'msg/s');
            drawGraph('bytesGraph', history.bytes, '', true);

            // Memory
            if (data.performance.memoryUsage) {
                const mem = data.performance.memoryUsage;
                document.getElementById('heapUsed').textContent =
                    (mem.heapUsed / 1024 / 1024).toFixed(1) + ' MB';
                document.getElementById('heapTotal').textContent =
                    (mem.heapTotal / 1024 / 1024).toFixed(1) + ' MB';
                document.getElementById('rss').textContent =
                    (mem.rss / 1024 / 1024).toFixed(1) + ' MB';
            }
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
