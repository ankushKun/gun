function themeVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
}

window.themeVar = themeVar;

const INTERACTIVE =
    'a[href],button:not(:disabled),summary,label[for],select,' +
    'input[type="button"],input[type="submit"],input[type="reset"],input[type="checkbox"],input[type="radio"],' +
    '.peers-toggle,.explorer-node-row,.explorer-ref,' +
    '[role="button"]:not([aria-disabled="true"]),[role="link"][href]';

function syncPointerCursor(event) {
    const root = document.documentElement;
    const target = event?.target;
    if (!target?.closest) {
        root.classList.remove('cursor-pointer');
        return;
    }
    if (target.closest('#graphCanvas')) {
        root.classList.remove('cursor-pointer');
        return;
    }
    root.classList.toggle('cursor-pointer', Boolean(target.closest(INTERACTIVE)));
}

document.addEventListener('pointermove', syncPointerCursor, { passive: true });
document.addEventListener('pointerleave', () => {
    document.documentElement.classList.remove('cursor-pointer');
}, true);

function isOffSubdomain(href) {
    if (!href || href.startsWith("#") || href.startsWith("javascript:")) return false;
    try {
        const url = new URL(href, location.href);
        if (url.protocol !== "http:" && url.protocol !== "https:") return false;
        return url.hostname.toLowerCase() !== location.hostname.toLowerCase();
    } catch {
        return false;
    }
}

function externalizeLink(link) {
    if (!isOffSubdomain(link.getAttribute("href"))) return;
    link.target = "_blank";
    if (!/\bnoopener\b/.test(link.rel)) {
        link.rel = link.rel ? `${link.rel} noopener noreferrer` : "noopener noreferrer";
    }
}

function externalizeLinks(root = document) {
    if (root.matches?.("a[href]")) externalizeLink(root);
    root.querySelectorAll?.("a[href]").forEach(externalizeLink);
}

externalizeLinks();
new MutationObserver((mutations) => {
    for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
            if (node.nodeType === 1) externalizeLinks(node);
        }
    }
}).observe(document.documentElement, { childList: true, subtree: true });
