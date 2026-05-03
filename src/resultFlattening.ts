/** Flattens nested Salesforce query records into table-ready key/value rows. */
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

    // Child subquery payloads: expand into readable columns.
    if (Array.isArray((value as any).records)) {
        flattenChildSubquery(out, keyPath, value as { totalSize?: unknown; done?: unknown; records?: unknown[] });
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

function flattenChildSubquery(
    out: DisplayRow,
    keyPath: string,
    payload: { totalSize?: unknown; done?: unknown; records?: unknown[] }
): void {
    const records = Array.isArray(payload.records) ? payload.records : [];
    out[`${keyPath}.totalSize`] = String(payload.totalSize ?? records.length);
    out[`${keyPath}.done`] = String(payload.done ?? false);

    if (records.length === 0) {
        out[`${keyPath}[0]`] = 'null';
        return;
    }

    for (let i = 0; i < records.length; i++) {
        const rec = records[i];
        if (!rec || typeof rec !== 'object') {
            out[`${keyPath}[${i}]`] = String(rec);
            continue;
        }
        const entries = Object.entries(rec).filter(([k]) => k !== 'attributes');
        if (entries.length === 0) {
            out[`${keyPath}[${i}]`] = '{}';
            continue;
        }
        for (const [childKey, childValue] of entries) {
            flattenValue(out, `${keyPath}[${i}].${childKey}`, childValue);
        }
    }
}
