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

        // Performance
        if (data.performance) {
            document.getElementById('messagesProcessed').textContent =
                formatNumber(data.performance.messagesProcessed);
            document.getElementById('bytesTransferred').textContent =
                formatBytes(data.performance.bytesTransferred);

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
