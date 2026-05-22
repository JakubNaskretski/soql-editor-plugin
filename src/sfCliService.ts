import * as vscode from 'vscode';
import { execFile, execFileSync } from 'child_process';
import { normalizeSObjectApiName } from './sobjectName';
export { normalizeSObjectApiName } from './sobjectName';

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
            const result = this.runCliSync(['org', 'list', '--json']);
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
            const result = this.runCliSync(['sobject', 'list', '--json', ...targetOrgArgs]);
            const parsed = JSON.parse(result);
            this.objectListCache = parsed.result || [];
            this.lastObjectListError = undefined;
            return this.objectListCache!;
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
    async executeQuery(query: string, useToolingApi: boolean = false): Promise<any> {
        const args = ['data', 'query', '--query', query, '--json', '--result-format', 'json'];
        if (useToolingApi) {
            args.push('--use-tooling-api');
        }
        args.push(...this.getTargetOrgArgs());

        // Pass the redacted log line as logLabel so runCliAsync doesn't emit a
        // second `sf data query ...` line that would leak the full query in argv.
        const logLabel = `sf data query --json --result-format json (query redacted, length=${query.length})`;
        const stdout = await this.runCliAsync(args, { logLabel });
        try {
            const parsed = JSON.parse(stdout);
            if (parsed.status === 0) {
                return parsed.result;
            }
            throw new Error(parsed.message || 'Query failed');
        } catch (err: any) {
            throw new Error(err?.message || 'Failed to parse query result');
        }
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

    private runCliSync(args: string[]): string {
        this.log('cmd', `sf ${this.redactArgsForLog(args)}`);
        return execFileSync('sf', args, {
            encoding: 'utf-8',
            timeout: 60000,
            maxBuffer: 10 * 1024 * 1024,
        });
    }

    private async runCliAsync(
        args: string[],
        options?: { timeoutMs?: number; logLabel?: string }
    ): Promise<string> {
        this.log('cmd', options?.logLabel || `sf ${this.redactArgsForLog(args)}`);
        return new Promise((resolve, reject) => {
            execFile(
                'sf',
                args,
                { timeout: options?.timeoutMs ?? 60000, maxBuffer: 10 * 1024 * 1024 },
                (error, stdout, stderr) => {
                if (stderr && stderr.trim()) {
                    this.log('warn', `stderr: ${stderr.trim()}`);
                }
                if (error) {
                    const wrapped = new Error(error.message) as Error & { code?: string };
                    wrapped.code = (error as any)?.code;
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
