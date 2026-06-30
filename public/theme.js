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
