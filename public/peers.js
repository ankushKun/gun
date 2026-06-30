const PEER_TOKEN_KEY = 'gun-peer-edit-token';

let meshPeers = [];

function peerAuthHeaders() {
    const token = sessionStorage.getItem(PEER_TOKEN_KEY);
    return token ? { authorization: `Bearer ${token}` } : {};
}

function setMeshStatus(text, ok) {
    const el = document.getElementById('meshSyncStatus');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('ok', Boolean(ok));
}

function meshStatusLabel(status) {
    switch (status) {
        case 'connected': return 'connected';
        case 'reconnecting': return 'reconnecting…';
        case 'connecting': return 'connecting…';
        default: return 'disconnected';
    }
}

function renderPeerList() {
    const list = document.getElementById('peerList');
    if (!list) return;
    list.innerHTML = '';

    if (!meshPeers.length) {
        list.innerHTML = '<li class="peer-empty">no remote peers — worker mesh idle</li>';
        return;
    }

    for (const peer of meshPeers) {
        const li = document.createElement('li');
        li.className = 'peer-item';
        const status = peer.meshStatus || 'disconnected';
        li.innerHTML =
            `<span class="peer-url">${escapeHtml(peer.url)}</span>` +
            `<span class="peer-meta">${meshStatusLabel(status)} · added ${formatPeerTime(peer.addedAt)}</span>` +
            `<button type="button" class="peer-remove" data-id="${peer.id}">remove</button>`;
        li.classList.toggle('peer-connected', status === 'connected');
        list.appendChild(li);
    }

    list.querySelectorAll('.peer-remove').forEach((btn) => {
        btn.addEventListener('click', () => removePeer(btn.dataset.id));
    });
}

window.renderMeshStatus = function renderMeshStatus(mesh) {
    if (!mesh) return;
    meshPeers = mesh.peers || meshPeers;
    renderPeerList();
    const connected = mesh.connected ?? meshPeers.filter((p) => p.meshStatus === 'connected').length;
    const total = meshPeers.length;
    if (!total) {
        setMeshStatus('server mesh idle (no remote peers)', false);
        return;
    }
    setMeshStatus(`server mesh: ${connected}/${total} connected`, connected > 0);
};

function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

function formatPeerTime(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleString();
}

async function loadPeers() {
    const res = await fetch('/api/peers');
    if (!res.ok) throw new Error('failed to load peers');
    const data = await res.json();
    window.renderMeshStatus(data);
    toggleTokenField(data.editProtected);
    return data;
}

function toggleTokenField(protectedEdits) {
    const row = document.getElementById('peerTokenRow');
    if (row) row.hidden = !protectedEdits;
}

async function verifyPeerUrl() {
    const input = document.getElementById('peerUrlInput');
    const msg = document.getElementById('peerFormMsg');
    const url = input.value.trim();
    if (!url) {
        msg.textContent = 'enter a url';
        return;
    }

    msg.textContent = 'checking…';
    try {
        const res = await fetch('/api/peers/verify', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url })
        });
        const data = await res.json();
        if (!data.ok) {
            msg.textContent = data.error || 'invalid url';
            return;
        }
        if (!data.reachable) {
            msg.textContent = data.error || 'unreachable';
            return;
        }
        if (!data.verified) {
            msg.textContent = `reachable (HTTP ${data.status}) but no gun peer signals — proceed with caution`;
            return;
        }
        msg.textContent = `verified gun peer at ${data.url}`;
        input.value = data.url;
    } catch {
        msg.textContent = 'verify failed';
    }
}

async function addPeerUrl() {
    const input = document.getElementById('peerUrlInput');
    const msg = document.getElementById('peerFormMsg');
    const url = input.value.trim();
    if (!url) {
        msg.textContent = 'enter a url';
        return;
    }

    msg.textContent = 'adding…';
    try {
        const res = await fetch('/api/peers', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...peerAuthHeaders() },
            body: JSON.stringify({ url })
        });
        const data = await res.json();
        if (res.status === 401) {
            msg.textContent = 'edit token required — enter token below';
            document.getElementById('peerTokenRow').hidden = false;
            return;
        }
        if (!data.ok) {
            msg.textContent = data.error || 'could not add peer';
            return;
        }
        msg.textContent = 'peer added — worker connecting in background';
        input.value = '';
        await loadPeers();
    } catch {
        msg.textContent = 'add failed';
    }
}

async function removePeer(id) {
    const msg = document.getElementById('peerFormMsg');
    msg.textContent = 'removing…';
    try {
        const res = await fetch(`/api/peers?id=${encodeURIComponent(id)}`, {
            method: 'DELETE',
            headers: peerAuthHeaders()
        });
        const data = await res.json();
        if (res.status === 401) {
            msg.textContent = 'edit token required';
            document.getElementById('peerTokenRow').hidden = false;
            return;
        }
        if (!data.ok) {
            msg.textContent = data.error || 'remove failed';
            return;
        }
        msg.textContent = 'peer removed';
        await loadPeers();
    } catch {
        msg.textContent = 'remove failed';
    }
}

async function reconnectMesh() {
    const msg = document.getElementById('peerFormMsg');
    msg.textContent = 'reconnecting server mesh…';
    try {
        const res = await fetch('/api/peers/reconnect', {
            method: 'POST',
            headers: peerAuthHeaders()
        });
        const data = await res.json();
        if (res.status === 401) {
            msg.textContent = 'edit token required';
            document.getElementById('peerTokenRow').hidden = false;
            return;
        }
        msg.textContent = 'server mesh reconnect triggered';
        window.renderMeshStatus({ peers: data.peers, connected: data.peers.filter((p) => p.meshStatus === 'connected').length });
    } catch {
        msg.textContent = 'reconnect failed';
    }
}

function initPeers() {
    document.getElementById('peerVerifyBtn')?.addEventListener('click', verifyPeerUrl);
    document.getElementById('peerAddBtn')?.addEventListener('click', addPeerUrl);
    document.getElementById('meshSyncBtn')?.addEventListener('click', reconnectMesh);

    const tokenInput = document.getElementById('peerTokenInput');
    tokenInput?.addEventListener('change', () => {
        sessionStorage.setItem(PEER_TOKEN_KEY, tokenInput.value.trim());
    });
    if (tokenInput && sessionStorage.getItem(PEER_TOKEN_KEY)) {
        tokenInput.value = sessionStorage.getItem(PEER_TOKEN_KEY);
    }

    loadPeers().catch(() => {
        const msg = document.getElementById('peerFormMsg');
        if (msg) msg.textContent = 'could not load peer list';
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPeers);
} else {
    initPeers();
}
