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

/**
 * Wraps Salesforce CLI (`sf`) commands to interact with orgs.
 */
export class SfCliService {
    private currentOrg: OrgInfo | undefined;
    private metadataCache: Map<string, SObjectDescribe> = new Map();
    private objectListCache: string[] | undefined;
    private outputChannel: vscode.OutputChannel;

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
            return this.objectListCache!;
        } catch (err: any) {
            this.log('error', `Failed to list objects: ${err.message}`);
            return [];
        }
    }

    /**
     * Describe an SObject to get its fields.
     */
    async describeSObject(objectName: string): Promise<SObjectDescribe | undefined> {
        const normalizedName = normalizeSObjectApiName(objectName);
        if (!normalizedName) {
            this.log('warn', `Rejected invalid SObject API name: "${objectName}"`);
            return undefined;
        }

        const key = normalizedName.toLowerCase();
        if (this.metadataCache.has(key)) {
            return this.metadataCache.get(key);
        }

        const targetOrgArgs = this.getTargetOrgArgs();
        try {
            const result = this.runCliSync([
                'sobject',
                'describe',
                '--sobject',
                normalizedName,
                '--json',
                ...targetOrgArgs,
            ]);
            const parsed = JSON.parse(result);
            const r = parsed.result;

            const describe: SObjectDescribe = {
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

            this.metadataCache.set(key, describe);
            return describe;
        } catch (err: any) {
            this.log('error', `Failed to describe ${normalizedName}: ${err.message}`);
            return undefined;
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

        // Keep logs useful without leaking full query text.
        this.log('cmd', `sf data query --json --result-format json (query redacted, length=${query.length})`);

        const stdout = await this.runCliAsync(args);
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

    private runCliSync(args: string[]): string {
        this.log('cmd', `sf ${args.join(' ')}`);
        return execFileSync('sf', args, {
            encoding: 'utf-8',
            timeout: 60000,
            maxBuffer: 10 * 1024 * 1024,
        });
    }

    private async runCliAsync(args: string[]): Promise<string> {
        this.log('cmd', `sf ${args[0]} ...`);
        return new Promise((resolve, reject) => {
            execFile('sf', args, { timeout: 60000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
                if (stderr && stderr.trim()) {
                    this.log('warn', `stderr: ${stderr.trim()}`);
                }
                if (error) {
                    reject(new Error(error.message));
                    return;
                }
                resolve(stdout);
            });
        });
    }
}
