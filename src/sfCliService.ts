import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promises as fsp } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { normalizeSObjectApiName } from './sobjectName';
import { resolveSfCommand, planSpawn } from './kit/sfCli';
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

/** Collapse repeated `sf org list` rows by the target identity the family
 * stores and passes back to the CLI. The CLI can report one authenticated
 * username in more than one result bucket; usernames are case-insensitive, so
 * bucket/casing variants must still render as one picker entry. */
export function dedupeOrgInfos(orgs: OrgInfo[]): OrgInfo[] {
    const byUsername = new Map<string, OrgInfo>();
    for (const org of orgs) {
        if (!org || typeof org.username !== 'string') { continue; }
        const username = org.username.trim();
        if (!username) { continue; }

        const key = username.toLowerCase();
        const previous = byUsername.get(key);
        const alias = typeof org.alias === 'string' ? org.alias.trim() : '';
        const previousAlias = previous?.alias.trim() ?? '';
        const previousHasFriendlyAlias = !!previousAlias
            && previousAlias.toLowerCase() !== previous?.username.trim().toLowerCase();
        const nextHasFriendlyAlias = !!alias && alias.toLowerCase() !== key;

        byUsername.set(key, {
            // Preserve the first CLI spelling of the username (the value written
            // to the shared setting), but enrich a username-only row when a
            // later bucket carries its friendly alias or instance URL.
            username: previous?.username ?? username,
            alias: previousHasFriendlyAlias
                ? previousAlias
                : (nextHasFriendlyAlias ? alias : (previous?.alias || alias || username)),
            instanceUrl: previous?.instanceUrl || org.instanceUrl || '',
            isDefault: Boolean(previous?.isDefault || org.isDefault),
        });
    }
    return [...byUsername.values()];
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
    /** Abort the CLI describe when the caller cancels (e.g. a completion token). */
    signal?: AbortSignal;
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
    /** Absolute path (or bare name) of the `sf` launcher, resolved once. On
     *  Windows this is the `sf.cmd`/`sf.ps1` shim path; on POSIX it stays
     *  `'sf'`. This raw path is NOT directly startable by `execFile` on
     *  Windows — Node refuses `.cmd`/`.bat` with `shell:false` (EINVAL) even
     *  via an absolute path — so `runCliAsync` runs it through `planSpawn`
     *  (bypasses to `node .../bin/run.js`, or `cmd.exe /d /s /c` as a last
     *  resort) before every `execFile` call. Fixes the family-wide Windows bug
     *  where `execFile('sf')` failed and was misreported as "sf not found on
     *  PATH". */
    private resolvedSfCommand: string | undefined;

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

    /** Clear the current org (e.g. the shared cross-plugin setting was emptied
     *  externally). Drops the per-org caches so the next selection starts clean. */
    clearCurrentOrg() {
        this.currentOrg = undefined;
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
            // --skip-connection-status: don't probe every org's auth over the
            // network. That probe is the slow part of `sf org list` (seconds per
            // org), and an org that fails it can drop out of the result — which
            // downstream code reads as "org gone" and can wipe the saved
            // selection. We never read connectedStatus, so skipping it is pure win.
            const result = await this.runCliAsync(['org', 'list', '--skip-connection-status', '--json']);
            const parsed = JSON.parse(result);
            // sf org list returns { result: { nonScratchOrgs: [...], scratchOrgs: [...] } }
            const allOrgs = [
                ...(parsed.result?.nonScratchOrgs || []),
                ...(parsed.result?.scratchOrgs || []),
                ...(parsed.result?.sandboxes || []),
                ...(parsed.result?.other || []),
            ];

            const orgs: OrgInfo[] = [];
            for (const o of allOrgs) {
                if (!o || typeof o.username !== 'string' || !o.username.trim()) {
                    continue;
                }
                const username = o.username.trim();
                orgs.push({
                    alias: typeof o.alias === 'string' && o.alias.trim() ? o.alias.trim() : username,
                    username,
                    instanceUrl: typeof o.instanceUrl === 'string' ? o.instanceUrl : '',
                    isDefault: o.isDefaultUsername || o.defaultMarker === '(U)' || false,
                });
            }

            return dedupeOrgInfos(orgs);
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
        // Capture the org this describe runs against. If a switch lands before the
        // CLI returns, the result belongs to the org named in argv above — caching
        // it now would poison (and later serve) the NEW org's in-memory cache.
        const orgAtStart = this.currentOrg?.username;
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
                signal: options?.signal,
                logLabel: `sf sobject describe --sobject ${normalizedName} --json`,
            });
            const describe = this.parseDescribeResult(result);

            // Only cache when still on the org we described; otherwise return the
            // data to the caller but leave the (now different) org's cache alone.
            if (this.currentOrg?.username === orgAtStart) {
                this.metadataCache.set(key, describe);
            }
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
        // The SOQL travels via a temp FILE (`--file`), never argv. Three reasons:
        // (1) Windows — planSpawn's cmd.exe fallback rightly refuses argv containing
        // newlines or double quotes, which multi-line/quoted SOQL (this editor's
        // bread and butter) always trips; (2) a big query can overflow the ~8k
        // Windows command-line limit; (3) argv leaks the query (possible PII in
        // WHERE filters) into process lists and spawn errors — a file keeps it
        // out of both entirely.
        const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'soql-editor-'));
        const queryFile = path.join(tmpDir, 'query.soql');
        try {
            await fsp.writeFile(queryFile, query, 'utf8');
        } catch (err) {
            await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
            // A temp-write failure is NOT a query error — name it, don't let it
            // fall through buildQueryError's generic "CLI returned no detail".
            throw new SoqlQueryError({ message: `Could not stage the query to a temp file: ${err instanceof Error ? err.message : String(err)}` });
        }
        const args = ['data', 'query', '--file', queryFile, '--json', '--result-format', 'json'];
        if (useToolingApi) {
            args.push('--use-tooling-api');
        }
        args.push(...this.getTargetOrgArgs());

        // Redacted log line: the temp path is meaningless to readers and the query
        // itself stays out of the output channel.
        const logLabel = `sf data query --json --result-format json (query via temp file, length=${query.length})`;

        let stdout: string;
        try {
            stdout = await this.runCliAsync(args, { logLabel, signal });
        } catch (err: any) {
            // `sf` exits non-zero on query errors. We parse the CLI's JSON error
            // envelope (written to stdout) into a structured, readable error.
            throw this.buildQueryError(err);
        } finally {
            await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
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
        // Resolve the launcher once (Windows `sf.cmd` shim path; `'sf'` elsewhere).
        if (this.resolvedSfCommand === undefined) {
            this.resolvedSfCommand = resolveSfCommand();
        }
        const sfCommand = this.resolvedSfCommand;
        return new Promise((resolve, reject) => {
            // planSpawn rewrites a Windows `.cmd`/`.bat` launcher (Node refuses to
            // execFile those with shell:false, even via an absolute path — EINVAL)
            // into something actually spawnable: node running the npm-layout
            // bin/run.js directly, or cmd.exe /d /s /c with validated/quoted argv.
            // On non-Windows (and for a bare 'sf' on Windows) it is a no-op passthrough.
            const plan = planSpawn(sfCommand, args);
            execFile(
                plan.command,
                plan.args,
                {
                    timeout: options?.timeoutMs ?? 60000,
                    maxBuffer: 10 * 1024 * 1024,
                    signal: options?.signal,
                    windowsVerbatimArguments: plan.windowsVerbatimArguments,
                },
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
