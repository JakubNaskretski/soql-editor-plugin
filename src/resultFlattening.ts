export type DisplayRow = Record<string, string>;

export function flattenRecordForDisplay(record: any): DisplayRow {
    const out: DisplayRow = {};

    for (const [key, value] of Object.entries(record || {})) {
        if (key === 'attributes') { continue; }
        flattenValue(out, key, value);
    }

    return out;
}

function flattenValue(out: DisplayRow, keyPath: string, value: any): void {
    if (value === null || value === undefined) {
        out[keyPath] = 'null';
        return;
    }

    if (Array.isArray(value)) {
        out[keyPath] = JSON.stringify(value);
        return;
    }

    if (typeof value !== 'object') {
        out[keyPath] = String(value);
        return;
    }

    // Child subquery payloads can be large (records arrays). Keep as compact JSON.
    if (Array.isArray((value as any).records)) {
        out[keyPath] = JSON.stringify(value);
        return;
    }

    const entries = Object.entries(value).filter(([k]) => k !== 'attributes');
    if (entries.length === 0) {
        out[keyPath] = '{}';
        return;
    }

    for (const [childKey, childValue] of entries) {
        flattenValue(out, `${keyPath}.${childKey}`, childValue);
    }
}
