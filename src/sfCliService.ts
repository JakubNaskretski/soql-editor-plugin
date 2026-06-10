import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { normalizeSObjectApiName } from './sobjectName';
export { normalizeSObjectApiName } from './sobjectName';

/** A SOQL query failure parsed into its useful parts. */
export interface ParsedQueryError {
    /** Concise, single-line message suitable for a toast (code + explanation + position). */
    message: string;
    /** Full multi-line CLI text (query echo + caret + explanation) for the panel/output. */
    detail?: string;
    /** Salesforce error code/name, e.g. INVALID_FIELD, MALFORMED_QUERY. */
    code?: string;
    /** 1-based line of the error within the submitted query, if reported. */
    line?: number;
    /** 1-based column of the error within the submitted query, if reported. */
    column?: number;
}

/** Error thrown by query execution, carrying the parsed Salesforce error detail. */
export class SoqlQueryError extends Error {
    readonly code?: string;
    readonly detail?: string;
    readonly line?: number;
    readonly column?: number;
    constructor(info: ParsedQueryError) {
        super(info.message);
        this.name = 'SoqlQueryError';
        this.code = info.code;
        this.detail = info.detail;
        this.line = info.line;
        this.column = info.column;
    }
}

/**
 * Turn a raw Salesforce CLI error message into a structured, user-readable form.
 *
 * The CLI typically returns something like:
 *   "\nSELECT Naem FROM Account\n       ^\nERROR at Row:1:Column:8\nNo such column 'Naem' on entity 'Account'. ..."
 * From which we extract the position (Row/Column), a concise human explanation
 * (the text after the `ERROR at ...` marker), and keep the full text as `detail`
 * so the caret/position can be shown verbatim.
 */
export function parseSoqlQueryError(rawMessage: string, code?: string): ParsedQueryError {
    const raw = (rawMessage || '').replace(/\r\n/g, '\n');
    const detail = raw.replace(/^\n+/, '').replace(/\n+$/, '');

    let line: number | undefined;
    let column: number | undefined;
    const pos = raw.match(/Row\s*:?\s*(\d+)\s*:?\s*Column\s*:?\s*(\d+)/i);
    if (pos) {
        line = Number(pos[1]);
        column = Number(pos[2]);
    }

    // Human explanation: prefer the text after the "ERROR at Row:..:Column:.." marker;
    // otherwise the last meaningful (non-caret) line; otherwise the whole message.
    let explanation = '';
    const afterMarker = raw.split(/ERROR at Row\s*:?\s*\d+\s*:?\s*Column\s*:?\s*\d+\s*/i);
    if (afterMarker.length > 1 && afterMarker[afterMarker.length - 1].trim()) {
        explanation = afterMarker[afterMarker.length - 1].trim();
    } else {
        const meaningful = detail
            .split('\n')
            .map(s => s.trim())
            .filter(Boolean)
            .filter(s => !/^\^+$/.test(s)); // drop the caret-only line
        explanation = meaningful.length ? meaningful[meaningful.length - 1] : detail;
    }
    explanation = explanation.trim() || 'Query failed';

    const codeClean = code && code !== 'Error' && code !== 'SfError' ? code : undefined;
    let message = explanation;
    if (codeClean && !explanation.toUpperCase().startsWith(codeClean.toUpperCase())) {
        message = `${codeClean}: ${explanation}`;
    }
    if (line !== undefined && column !== undefined) {
        message += ` (line ${line}, column ${column})`;
    }

    return {
        message,
        detail: detail && detail !== explanation ? detail : undefined,
        code: codeClean,
        line,
        column,
    };
}

export interface OrgInfo {
    alias: string;
    username: string;
    instanceUrl: string;
    isDefault: boolean;
}

export interface SObjectField {
    name: string;
    label: string;
    type: string;
    referenceTo: string[];
    relationshipName: string | null;
    picklistValues: { label: string; value: string }[];
    nillable: boolean;
    updateable: boolean;
    createable: boolean;
    // Capability flags used to filter clause suggestions (WHERE needs
    // filterable, ORDER BY sortable, GROUP BY groupable). Optional because
    // older disk caches and the local-project fallback don't carry them.
    filterable?: boolean;
    sortable?: boolean;
    groupable?: boolean;
}

export interface SObjectDescribe {
    name: string;
    label: string;
    fields: SObjectField[];
    childRelationships: { childSObject: string; field: string; relationshipName: string }[];
}

export interface DescribeOptions {
    timeoutMs?: number;
}

export interface DescribeResult {
    describe?: SObjectDescribe;
    reason?: 'timeout' | 'error';
    errorMessage?: string;
}

/**
 * Wraps Salesforce CLI (`sf`) commands to interact with orgs.
 */
export class SfCliService {
    private currentOrg: OrgInfo | undefined;
    private metadataCache: Map<string, SObjectDescribe> = new Map();
    private objectListCache: string[] | undefined;
    private outputChannel: vscode.OutputChannel;
    private lastObjectListError: string | undefined;

    private logEmitter = new vscode.EventEmitter<{ level: string; message: string }>();
    public readonly onLog = this.logEmitter.event;

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
    }

    private log(level: string, message: string) {
        this.outputChannel.appendLine(`[${level}] ${message}`);
        this.logEmitter.fire({ level, message });
    }

    getCurrentOrg(): OrgInfo | undefined {
        return this.currentOrg;
    }

    setCurrentOrg(org: OrgInfo) {
        this.currentOrg = org;
        this.clearCache();
    }

    clearCache() {
        this.metadataCache.clear();
        this.objectListCache = undefined;
    }

    getCachedDescribe(objectName: string): SObjectDescribe | undefined {
        return this.metadataCache.get(objectName.toLowerCase());
    }

    setCachedDescribe(objectName: string, describe: SObjectDescribe) {
        this.metadataCache.set(objectName.toLowerCase(), describe);
    }

    clearCachedDescribe(objectName: string) {
        this.metadataCache.delete(objectName.toLowerCase());
    }

    /**
     * List all authenticated orgs via `sf org list`.
     */
    async listOrgs(): Promise<OrgInfo[]> {
        try {
            const result = await this.runCliAsync(['org', 'list', '--json']);
            const parsed = JSON.parse(result);
            const orgs: OrgInfo[] = [];

            // sf org list returns { result: { nonScratchOrgs: [...], scratchOrgs: [...] } }
            const allOrgs = [
                ...(parsed.result?.nonScratchOrgs || []),
                ...(parsed.result?.scratchOrgs || []),
                ...(parsed.result?.sandboxes || []),
                ...(parsed.result?.other || []),
            ];

            for (const o of allOrgs) {
                orgs.push({
                    alias: o.alias || o.username,
                    username: o.username,
                    instanceUrl: o.instanceUrl || '',
                    isDefault: o.isDefaultUsername || o.defaultMarker === '(U)' || false,
                });
            }

            return orgs;
        } catch (err: any) {
            this.log('error', `Failed to list orgs: ${err.message}`);
            throw new Error(`Failed to list orgs. Is Salesforce CLI (sf) installed?\n${err.message}`);
        }
    }

    /**
     * Get list of all SObject API names for the current org.
     *
     * On CLI failure, logs and returns `[]` (so autocomplete keeps working from
     * disk/fallback) but exposes the failure message via `getLastObjectListError`
     * so callers can surface a one-shot status notification.
     */
    async getObjectList(): Promise<string[]> {
        if (this.objectListCache) {
            return this.objectListCache;
        }

        const targetOrgArgs = this.getTargetOrgArgs();
        try {
            const result = await this.runCliAsync(['sobject', 'list', '--json', ...targetOrgArgs]);
            const parsed = JSON.parse(result);
            // Defensive: a malformed CLI envelope (result missing or not an
            // array) must not poison the cache with a non-array — callers
            // iterate this value on every keystroke.
            const raw = parsed?.result;
            if (!Array.isArray(raw)) {
                this.lastObjectListError = 'sf sobject list returned an unexpected payload shape';
                this.log('warn', this.lastObjectListError);
                return [];
            }
            this.objectListCache = raw.filter((n): n is string => typeof n === 'string');
            this.lastObjectListError = undefined;
            return this.objectListCache;
        } catch (err: any) {
            this.lastObjectListError = err?.message || 'sf sobject list failed';
            this.log('error', `Failed to list objects: ${this.lastObjectListError}`);
            return [];
        }
    }

    /** Returns the last error message from `getObjectList`, or undefined on success. */
    getLastObjectListError(): string | undefined {
        return this.lastObjectListError;
    }

    /**
     * Describe an SObject to get its fields.
     */
    async describeSObject(objectName: string, options?: DescribeOptions): Promise<SObjectDescribe | undefined> {
        const result = await this.describeSObjectDetailed(objectName, options);
        return result.describe;
    }

    /**
     * Describe an SObject and return detailed failure reason.
     */
    async describeSObjectDetailed(objectName: string, options?: DescribeOptions): Promise<DescribeResult> {
        const normalizedName = normalizeSObjectApiName(objectName);
        if (!normalizedName) {
            this.log('warn', `Rejected invalid SObject API name: "${objectName}"`);
            return { reason: 'error', errorMessage: 'Invalid SObject API name' };
        }

        const key = normalizedName.toLowerCase();
        if (this.metadataCache.has(key)) {
            return { describe: this.metadataCache.get(key) };
        }

        const targetOrgArgs = this.getTargetOrgArgs();
        try {
            const result = await this.runCliAsync([
                'sobject',
                'describe',
                '--sobject',
                normalizedName,
                '--json',
                ...targetOrgArgs,
            ], {
                timeoutMs: options?.timeoutMs,
                logLabel: `sf sobject describe --sobject ${normalizedName} --json`,
            });
            const describe = this.parseDescribeResult(result);

            this.metadataCache.set(key, describe);
            return { describe };
        } catch (err: any) {
            const timedOut = this.isTimeoutError(err);
            this.log('error', `Failed to describe ${normalizedName}: ${err.message}`);
            return {
                reason: timedOut ? 'timeout' : 'error',
                errorMessage: err?.message || 'Unknown error',
            };
        }
    }

    /**
     * Execute a SOQL query using the Tooling API or regular Data API.
     */
    async executeQuery(query: string, useToolingApi: boolean = false, signal?: AbortSignal): Promise<any> {
        const args = ['data', 'query', '--query', query, '--json', '--result-format', 'json'];
        if (useToolingApi) {
            args.push('--use-tooling-api');
        }
        args.push(...this.getTargetOrgArgs());

        // Pass the redacted log line as logLabel so runCliAsync doesn't emit a
        // second `sf data query ...` line that would leak the full query in argv.
        const logLabel = `sf data query --json --result-format json (query redacted, length=${query.length})`;

        let stdout: string;
        try {
            stdout = await this.runCliAsync(args, { logLabel, signal });
        } catch (err: any) {
            // `sf` exits non-zero on query errors. Node's error.message embeds the
            // full argv — including the SOQL, which may contain PII in WHERE
            // filters — so we never surface it. We parse the CLI's JSON error
            // envelope (written to stdout) into a structured, readable error.
            throw this.buildQueryError(err);
        }

        let parsed: any;
        try {
            parsed = JSON.parse(stdout);
        } catch {
            throw new SoqlQueryError({ message: 'Failed to parse query result returned by the CLI.' });
        }
        if (parsed.status === 0) {
            return parsed.result;
        }
        // Non-zero status surfaced on a zero-exit (rare) — parse it the same way.
        throw new SoqlQueryError(parseSoqlQueryError(parsed.message || '', parsed.name || parsed.code));
    }

    /**
     * Open a record in the browser using the CLI's authenticated session.
     *
     * Opening the bare `instanceUrl/<id>` lands on the org login page whenever the
     * browser has no active Salesforce session. `sf org open --path /<id>` instead
     * mints a short-lived frontdoor URL from the CLI's stored auth and opens the
     * record already logged in. The session id is minted and consumed by the
     * CLI/browser — it never passes through (or is logged by) this process.
     *
     * @returns true if the CLI launched the record; false if there is no current
     *          org, the id is malformed, or the CLI failed (caller can fall back).
     */
    async openRecord(recordId: string): Promise<boolean> {
        const org = this.currentOrg;
        if (!org) { return false; }
        // Defense in depth: only ever hand a strict 15/18-char Salesforce id to the
        // CLI as a navigation path (mirrors the panel's pre-validation).
        if (!/^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(recordId)) {
            this.log('warn', 'openRecord rejected: invalid record id');
            return false;
        }
        try {
            await this.runCliAsync([
                'org', 'open',
                '--path', `/${recordId}`,
                '--target-org', org.username,
            ]);
            return true;
        } catch (err: any) {
            this.log('error', `Failed to open record via CLI: ${err.message}`);
            return false;
        }
    }

    /** Build a structured, user-readable error from a failed CLI invocation. */
    private buildQueryError(err: any): SoqlQueryError {
        if (err?.code === 'ENOENT') {
            return new SoqlQueryError({ message: 'Salesforce CLI (sf) not found on PATH. Install it and reload VS Code.' });
        }
        if (this.isBufferOverflowError(err)) {
            return new SoqlQueryError({ message: 'Query result is too large to display. Add a LIMIT clause or select fewer fields.' });
        }
        const envelope = this.parseEnvelope(err?.stdout);
        const rawMessage =
            (typeof envelope?.message === 'string' && envelope.message.trim() ? envelope.message : '') ||
            (typeof err?.stderr === 'string' ? err.stderr.trim() : '') ||
            '';
        if (!rawMessage) {
            return new SoqlQueryError({ message: 'Query failed (the CLI returned no error detail).' });
        }
        return new SoqlQueryError(parseSoqlQueryError(rawMessage, envelope?.name || envelope?.code));
    }

    private parseEnvelope(stdout: unknown): any | undefined {
        if (typeof stdout !== 'string' || !stdout.trim()) { return undefined; }
        try {
            return JSON.parse(stdout);
        } catch {
            return undefined;
        }
    }

    private isBufferOverflowError(err: any): boolean {
        return err?.code === 'ENOBUFS'
            || err?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
            || /maxBuffer|ENOBUFS/i.test(String(err?.message || ''));
    }

    private getTargetOrgArgs(): string[] {
        if (this.currentOrg) {
            return ['--target-org', this.currentOrg.username];
        }
        return [];
    }

    /**
     * Redact sensitive values from CLI argv before logging.
     *
     * Handles both forms accepted by oclif-style CLIs:
     *   - separated:  `['--query', 'SELECT ...']`  → value redacted
     *   - inline:     `['--query=SELECT ...']`     → value after `=` redacted
     *
     * Centralized so future flag additions only need a single allowlist update.
     */
    private redactArgsForLog(args: string[]): string {
        // Long and short forms of every sensitive flag. We don't currently
        // emit the short forms, but listing them keeps the allowlist a single
        // source of truth if a caller ever switches.
        const SENSITIVE = new Set([
            '--query', '-q',
            '--password', '-p',
            '--token',
        ]);
        const safe: string[] = [];
        for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            // Inline form: --flag=value or -q=value
            const eqIdx = arg.indexOf('=');
            if (eqIdx > 0 && SENSITIVE.has(arg.slice(0, eqIdx))) {
                safe.push(`${arg.slice(0, eqIdx)}=<redacted>`);
                continue;
            }
            safe.push(arg);
            // Separated form: --flag value / -q value
            if (SENSITIVE.has(arg) && i + 1 < args.length) {
                safe.push('<redacted>');
                i++;
            }
        }
        return safe.join(' ');
    }

    private async runCliAsync(
        args: string[],
        options?: { timeoutMs?: number; logLabel?: string; signal?: AbortSignal }
    ): Promise<string> {
        this.log('cmd', options?.logLabel || `sf ${this.redactArgsForLog(args)}`);
        return new Promise((resolve, reject) => {
            execFile(
                'sf',
                args,
                { timeout: options?.timeoutMs ?? 60000, maxBuffer: 10 * 1024 * 1024, signal: options?.signal },
                (error, stdout, stderr) => {
                if (stderr && stderr.trim()) {
                    this.log('warn', `stderr: ${stderr.trim()}`);
                }
                if (error) {
                    // Attach stdout/stderr so callers can recover the CLI's JSON
                    // error envelope (which carries a clean message) instead of
                    // surfacing Node's error.message, which embeds the full argv.
                    const wrapped = new Error(error.message) as Error & {
                        code?: string; stdout?: string; stderr?: string;
                    };
                    wrapped.code = (error as any)?.code;
                    wrapped.stdout = typeof stdout === 'string' ? stdout : '';
                    wrapped.stderr = typeof stderr === 'string' ? stderr : '';
                    reject(wrapped);
                    return;
                }
                resolve(stdout);
                }
            );
        });
    }

    private isTimeoutError(err: any): boolean {
        const message = String(err?.message || '');
        return err?.code === 'ETIMEDOUT' || /ETIMEDOUT|timed out/i.test(message);
    }

    private parseDescribeResult(rawJson: string): SObjectDescribe {
        const parsed = JSON.parse(rawJson);
        const r = parsed.result;
        return {
            name: r.name,
            label: r.label,
            fields: (r.fields || []).map((f: any) => ({
                name: f.name,
                label: f.label,
                type: f.type,
                referenceTo: f.referenceTo || [],
                relationshipName: f.relationshipName || null,
                picklistValues: (f.picklistValues || []).filter((p: any) => p.active),
                nillable: f.nillable,
                updateable: f.updateable,
                createable: f.createable,
                filterable: typeof f.filterable === 'boolean' ? f.filterable : undefined,
                sortable: typeof f.sortable === 'boolean' ? f.sortable : undefined,
                groupable: typeof f.groupable === 'boolean' ? f.groupable : undefined,
            })),
            childRelationships: (r.childRelationships || [])
                .filter((c: any) => c.relationshipName)
                .map((c: any) => ({
                    childSObject: c.childSObject,
                    field: c.field,
                    relationshipName: c.relationshipName,
                })),
        };
    }
}
