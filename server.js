#!/usr/bin/env node
const express = require('express');
const Gun = require('gun');
const compression = require('compression');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 8765;

// Stats tracking
const stats = {
    startTime: Date.now(),
    connections: 0,
    totalConnections: 0,
    peersConnected: new Set(),
    messagesProcessed: 0,
    bytesTransferred: 0
};

// Middleware
app.use(compression());
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            connectSrc: ["'self'", "ws:", "wss:"]
        }
    }
}));
app.use(cors());
app.use(express.json());

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Stats API endpoint
app.get('/api/stats', (req, res) => {
    const uptime = Date.now() - stats.startTime;
    const uptimeSeconds = Math.floor(uptime / 1000);
    const uptimeMinutes = Math.floor(uptimeSeconds / 60);
    const uptimeHours = Math.floor(uptimeMinutes / 60);
    const uptimeDays = Math.floor(uptimeHours / 24);

    res.json({
        status: 'online',
        uptime: {
            ms: uptime,
            seconds: uptimeSeconds,
            minutes: uptimeMinutes,
            hours: uptimeHours,
            days: uptimeDays,
            formatted: `${uptimeDays}d ${uptimeHours % 24}h ${uptimeMinutes % 60}m ${uptimeSeconds % 60}s`
        },
        connections: {
            current: stats.connections,
            total: stats.totalConnections,
            activePeers: stats.peersConnected.size
        },
        performance: {
            messagesProcessed: stats.messagesProcessed,
            bytesTransferred: stats.bytesTransferred,
            memoryUsage: process.memoryUsage()
        }
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: Date.now() });
});

// Root endpoint
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Create HTTP server
const server = app.listen(PORT, () => {
    console.log(`┌────────────────────────────────────────┐`);
    console.log(`│  Gun.js Production Peer Server         │`);
    console.log(`├────────────────────────────────────────┤`);
    console.log(`│  Server running on port: ${PORT.toString().padEnd(13)} │`);
    console.log(`│  Dashboard: http://localhost:${PORT}/     │`);
    console.log(`│  Stats API: /api/stats                 │`);
    console.log(`│  Health: /health                       │`);
    console.log(`└────────────────────────────────────────┘`);
});

// Initialize Gun
const gun = Gun({
    web: server,
    file: 'data',
    localStorage: false,
    radisk: true,
    peers: process.env.PEERS ? process.env.PEERS.split(',') : []
});

// Track Gun events
gun.on('create', (at) => {
    stats.connections++;
    stats.totalConnections++;
});

gun.on('hi', (peer) => {
    stats.peersConnected.add(peer.id);
    console.log(`[${new Date().toISOString()}] Peer connected:`, peer.id);
});

gun.on('bye', (peer) => {
    stats.peersConnected.delete(peer.id);
    stats.connections = Math.max(0, stats.connections - 1);
    console.log(`[${new Date().toISOString()}] Peer disconnected:`, peer.id);
});

gun.on('in', (msg) => {
    stats.messagesProcessed++;
    if (msg && typeof msg === 'string') {
        stats.bytesTransferred += msg.length;
    } else if (msg) {
        stats.bytesTransferred += JSON.stringify(msg).length;
    }
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('\nSIGINT signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
        process.exit(0);
    });
});

// Error handling
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

module.exports = { app, gun, server };
