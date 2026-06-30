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
        list.innerHTML = '<li class="peer-empty">no peers yet</li>';
        return;
    }

    for (const peer of meshPeers) {
        const li = document.createElement('li');
        li.className = 'peer-item';
        const status = peer.meshStatus || 'disconnected';
        li.innerHTML =
            `<span class="peer-url">${escapeHtml(peer.url)}</span>` +
            `<span class="peer-meta">${meshStatusLabel(status)}</span>` +
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
        setMeshStatus('', false);
        return;
    }
    setMeshStatus(`${connected}/${total} connected`, connected > 0);
};

function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

async function loadPeers() {
    const res = await fetch('/api/peers');
    if (!res.ok) throw new Error('failed to load peers');
    const data = await res.json();
    window.renderMeshStatus(data);
    return data;
}

function promptEditToken() {
    sessionStorage.removeItem(PEER_TOKEN_KEY);
    const token = window.prompt('Edit token required to change peers:');
    if (!token?.trim()) {
        return null;
    }
    sessionStorage.setItem(PEER_TOKEN_KEY, token.trim());
    return token.trim();
}

async function addPeerUrl(retry = true) {
    const input = document.getElementById('peerUrlInput');
    const msg = document.getElementById('peerFormMsg');
    const url = input.value.trim();
    if (!url) {
        msg.textContent = 'enter a url';
        return;
    }

    msg.textContent = 'checking and adding…';
    try {
        const res = await fetch('/api/peers', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...peerAuthHeaders() },
            body: JSON.stringify({ url })
        });
        const data = await res.json();
        if (res.status === 401) {
            if (!retry) {
                sessionStorage.removeItem(PEER_TOKEN_KEY);
                msg.textContent = 'wrong edit token';
                return;
            }
            if (promptEditToken()) {
                return addPeerUrl(false);
            }
            msg.textContent = 'edit token required';
            return;
        }
        if (!data.ok) {
            msg.textContent = data.error || 'could not add peer';
            return;
        }
        msg.textContent = 'added — worker connecting automatically';
        input.value = '';
        await loadPeers();
    } catch {
        msg.textContent = 'add failed';
    }
}

async function removePeer(id, retry = true) {
    const msg = document.getElementById('peerFormMsg');
    msg.textContent = 'removing…';
    try {
        const res = await fetch(`/api/peers?id=${encodeURIComponent(id)}`, {
            method: 'DELETE',
            headers: peerAuthHeaders()
        });
        const data = await res.json();
        if (res.status === 401) {
            if (!retry) {
                sessionStorage.removeItem(PEER_TOKEN_KEY);
                msg.textContent = 'wrong edit token';
                return;
            }
            if (promptEditToken()) {
                return removePeer(id, false);
            }
            msg.textContent = 'edit token required';
            return;
        }
        if (!data.ok) {
            msg.textContent = data.error || 'remove failed';
            return;
        }
        msg.textContent = '';
        await loadPeers();
    } catch {
        msg.textContent = 'remove failed';
    }
}

function initPeersToggle() {
    const toggle = document.getElementById('peersToggle');
    const panel = document.getElementById('peersPanel');
    if (!toggle || !panel) return;

    toggle.addEventListener('click', () => {
        const open = toggle.getAttribute('aria-expanded') === 'true';
        toggle.setAttribute('aria-expanded', open ? 'false' : 'true');
        toggle.classList.toggle('peers-toggle--open', !open);
        panel.hidden = open;
    });
}

function initPeers() {
    initPeersToggle();

    document.getElementById('peerForm')?.addEventListener('submit', (event) => {
        event.preventDefault();
        addPeerUrl();
    });

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
