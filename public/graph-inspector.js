export const HISTORY_KEY_RE = /^(t\d+|s:\d+)$/;

export function isHistoryKey(key) {
    return HISTORY_KEY_RE.test(key);
}

const NUMERIC_KEY_RE = /^\d+$/;

export function isArrayShapedNode(raw) {
    const keys = Object.keys(raw || {}).filter((key) => key !== "_");
    if (!keys.length) return false;
    return keys.every((key) => NUMERIC_KEY_RE.test(key));
}

export function objectToArray(raw) {
    return Object.keys(raw || {})
        .filter((key) => key !== "_" && NUMERIC_KEY_RE.test(key))
        .sort((a, b) => Number(a) - Number(b))
        .map((key) => raw[key]);
}

export function groupInspectorFields(raw) {
    const named = [];
    const numeric = [];
    const history = [];
    const tombstones = [];

    for (const [key, value] of Object.entries(raw || {})) {
        if (key === "_") continue;
        if (value === null) tombstones.push([key, value]);
        else if (isHistoryKey(key)) history.push([key, value]);
        else if (NUMERIC_KEY_RE.test(key)) numeric.push([key, value]);
        else named.push([key, value]);
    }

    if (!named.length && !history.length && numeric.length) {
        return [{ id: "__items__", label: "items", value: objectToArray(raw), type: "array" }];
    }

    const out = [];
    for (const [key, value] of named) {
        out.push({ id: key, label: key, value });
    }

    if (history.length >= 2) {
        out.push({
            id: "__history__",
            label: `state history (${history.length})`,
            value: Object.fromEntries(history),
            type: "object",
            collapsed: true,
        });
    } else {
        for (const [key, value] of history) {
            out.push({ id: key, label: key, value });
        }
    }

    if (numeric.length && (named.length || history.length || tombstones.length)) {
        out.push({
            id: "__entries__",
            label: `entries (${numeric.length})`,
            value: numeric
                .sort((a, b) => Number(a[0]) - Number(b[0]))
                .map(([, value]) => value),
            type: "array",
        });
    }

    if (tombstones.length) {
        out.push({
            id: "__cleared__",
            label: `cleared fields (${tombstones.length})`,
            value: Object.fromEntries(tombstones),
            type: "object",
            collapsed: true,
        });
    }

    return out;
}
