/** Computes context-aware autocomplete suggestions for the sidebar editor. */
import { MetadataProvider } from './metadataProvider';
import { getQueryContext, extractFromObject, extractScopedFromInfo, getQueryDepthAtOffset, ScopedFromInfo } from './soqlParser';
import { resolveRelationshipChain } from './relationshipChain';
import { FieldUsage, isFieldUsableIn } from './soqlCatalog';

export interface Suggestion {
    label: string;
    detail: string;
    insertText: string;
}

const IDENTIFIER_CHAR_RE = /[A-Za-z0-9_.]/;

function isIdentifierChar(ch: string | undefined): boolean {
    return !!ch && IDENTIFIER_CHAR_RE.test(ch);
}

function getWordAtCursor(text: string, offset: number): { word: string; start: number; end: number } {
    let start = offset;
    while (start > 0 && isIdentifierChar(text[start - 1])) {
        start--;
    }

    let end = offset;
    while (end < text.length && isIdentifierChar(text[end])) {
        end++;
    }

    return {
        word: text.slice(start, end),
        start,
        end,
    };
}

function isCursorInsideIdentifier(text: string, offset: number): boolean {
    return isIdentifierChar(text[offset - 1]) && isIdentifierChar(text[offset]);
}

/**
 * Popularity weights for commonly-queried standard Salesforce objects.
 * Higher weight = higher priority in autocomplete results.
 * Custom objects (__c) get a small boost over unweighted standard objects.
 */
/**
 * Build the weight map from grouped tiers. Each group shares a single weight.
 */
const WEIGHTED_GROUPS: [number, string[]][] = [
    // ── core CRM ──
    [100, [
        'Account', 'Contact', 'Lead', 'Opportunity',
        'Case', 'User', 'Task', 'Event',
    ]],
    // ── sales ──
    [90, [
        'Campaign', 'CampaignMember',
        'OpportunityLineItem', 'OpportunityContactRole', 'OpportunityTeamMember',
        'Quote', 'QuoteLineItem',
        'Product2', 'Pricebook2', 'PricebookEntry',
        'Order', 'OrderItem',
        'Contract', 'ContractLineItem',
        'Asset', 'AssetRelationship',
        'Partner', 'AccountTeamMember',
        'Forecast', 'ForecastingItem',
    ]],
    // ── service & field service ──
    [80, [
        'CaseComment', 'CaseTeamMember', 'CaseTeamRole',
        'CaseContactRole', 'CaseSolution',
        'Entitlement', 'EntitlementContact', 'ServiceContract',
        'WorkOrder', 'WorkOrderLineItem',
        'ServiceAppointment', 'ServiceResource', 'ServiceTerritory',
        'AssignedResource', 'ResourceAbsence',
        'Skill', 'ServiceResourceSkill',
        'LiveChatTranscript', 'LiveAgentSession',
        'MessagingSession', 'MessagingEndUser',
    ]],
    // ── knowledge & solutions ──
    [70, [
        'Knowledge__kav', 'KnowledgeArticle', 'KnowledgeArticleVersion',
        'Solution',
        'CategoryData', 'CategoryNode',
    ]],
    // ── content, files & notes ──
    [60, [
        'ContentDocument', 'ContentVersion', 'ContentDocumentLink',
        'ContentFolder', 'ContentWorkspace', 'ContentWorkspaceMember',
        'Attachment', 'Note', 'Document', 'Folder',
    ]],
    // ── email & activities ──
    [50, [
        'EmailMessage', 'EmailTemplate', 'OrgWideEmailAddress',
        'ActivityHistory', 'OpenActivity',
        'TaskRelation', 'EventRelation',
    ]],
    // ── collaboration & chatter ──
    [40, [
        'FeedItem', 'FeedComment',
        'CollaborationGroup', 'CollaborationGroupMember',
        'Topic', 'TopicAssignment',
        'ChatterActivity',
    ]],
    // ── admin, security & config ──
    [30, [
        'Profile', 'UserRole', 'RecordType',
        'PermissionSet', 'PermissionSetAssignment', 'PermissionSetGroup',
        'ObjectPermissions', 'FieldPermissions',
        'Group', 'GroupMember',
        'UserLogin', 'UserPackageLicense',
        'BusinessHours', 'Organization', 'Holiday',
        'CustomPermission', 'SetupEntityAccess',
    ]],
    // ── sharing & history ──
    [25, [
        'AccountShare', 'ContactShare', 'LeadShare',
        'OpportunityShare', 'CaseShare',
        'AccountHistory', 'ContactHistory', 'LeadHistory',
        'OpportunityHistory', 'OpportunityFieldHistory', 'CaseHistory',
    ]],
    // ── reports & dashboards ──
    [20, [
        'Report', 'Dashboard', 'DashboardComponent',
    ]],
    // ── approval & flow ──
    [15, [
        'ProcessInstance', 'ProcessInstanceStep', 'ProcessInstanceWorkitem',
        'ProcessInstanceHistory',
        'FlowInterview', 'FlowDefinitionView', 'FlowVersionView',
    ]],
    // ── platform & metadata ──
    [10, [
        'ApexClass', 'ApexTrigger', 'ApexPage', 'ApexComponent', 'ApexLog',
        'StaticResource', 'AuraDefinitionBundle', 'LightningComponentBundle',
        'CustomObject', 'CustomField',
        'EntityDefinition', 'FieldDefinition', 'EntityParticle',
    ]],
    // ── monitoring & jobs ──
    [8, [
        'AsyncApexJob', 'CronTrigger', 'CronJobDetail',
        'EventLogFile', 'LoginHistory', 'SetupAuditTrail',
        'AuthSession', 'SessionPermSetActivation',
        'BatchApexErrorEvent',
    ]],
    // ── communities & experience ──
    [5, [
        'Network', 'NetworkMember', 'NetworkMemberGroup',
        'Site',
    ]],
    // ── person accounts & data model ──
    [5, [
        'Individual', 'ContactPointAddress', 'ContactPointEmail', 'ContactPointPhone',
        'AccountContactRelation', 'AccountContactRole',
    ]],
    // ── other standard objects ──
    [2, [
        'Idea', 'Vote', 'Metric',
        'Period', 'FiscalYearSettings',
        'ExternalDataSource', 'NamedCredential',
        'ConnectedApplication', 'InstalledMobileApp',
        'DuplicateRecordItem', 'DuplicateRecordSet',
        'DataAssessmentFieldMetric',
    ]],
];

const OBJECT_WEIGHTS: Record<string, number> = {};
for (const [weight, names] of WEIGHTED_GROUPS) {
    for (const name of names) {
        OBJECT_WEIGHTS[name] = weight;
    }
}


/** Custom objects should rank above Service/Field Service tier objects.
 *  Applies to every queryable custom suffix, not just __c — a packaged
 *  external object (__x) or metadata type (__mdt) is as deliberate a target
 *  as a __c when the user types its prefix. */
const CUSTOM_OBJECT_WEIGHT = 85;
const CUSTOM_SUFFIX_RE = /__(c|mdt|e|x|b|dlm)$/;

function getObjectWeight(name: string): number {
    return OBJECT_WEIGHTS[name] ?? (CUSTOM_SUFFIX_RE.test(name) ? CUSTOM_OBJECT_WEIGHT : 0);
}

function stripManagedNamespace(segment: string): string {
    // The namespace token permits single inner underscores (vlocity_cmt) just
    // like the describe-gate regex in sobjectName.ts.
    return segment.replace(/^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*__([A-Za-z0-9_]+__(?:r|c))$/i, '$1');
}

function truncateMiddle(value: string, maxLen: number): string {
    if (value.length <= maxLen) {
        return value;
    }
    const headLen = Math.max(10, Math.floor(maxLen * 0.6));
    const tailLen = Math.max(8, maxLen - headLen - 3);
    return `${value.slice(0, headLen)}...${value.slice(-tailLen)}`;
}

function toRelationshipDisplayLabel(fullPath: string): string {
    const parts = fullPath
        .split('.')
        .map(stripManagedNamespace);

    // Keep short labels untouched.
    const joined = parts.join('.');
    const maxLen = 46;
    if (joined.length <= maxLen) {
        return joined;
    }

    // For deep paths, preserve the nearest relationship/field context (last 2 parts)
    // and shorten earlier chain parts first.
    if (parts.length >= 3) {
        const tail = parts.slice(-2); // e.g. CreatedBy.FirstName
        const head = parts.slice(0, -2);

        const shortenedHead = head.map(p => (p.length > 12 ? `${p.slice(0, 12)}...` : p));
        let candidateParts = [...shortenedHead, ...tail];
        if (candidateParts.join('.').length <= maxLen) {
            return candidateParts.join('.');
        }

        // Collapse older path segments from the left into a single ellipsis,
        // while keeping the most recent relationship segment(s) readable.
        while (shortenedHead.length > 1 && candidateParts.join('.').length > maxLen) {
            shortenedHead.shift();
            if (shortenedHead[0] !== '...') {
                shortenedHead[0] = '...';
            }
            candidateParts = [...shortenedHead, ...tail];
        }

        const candidate = candidateParts.join('.');
        if (candidate.length <= maxLen) {
            return candidate;
        }

        // As a final fallback, keep only "...<nearest>.<field>".
        const fallback = ['...', ...tail].join('.');
        if (fallback.length <= maxLen) {
            return fallback;
        }
    }

    return truncateMiddle(joined, maxLen);
}

export async function getSuggestions(
    text: string,
    offset: number,
    metadata: MetadataProvider,
): Promise<Suggestion[]> {
    // Do not suggest while cursor is in the middle of an existing token.
    // This avoids noisy suggestions and bad replacement behavior.
    if (isCursorInsideIdentifier(text, offset)) {
        return [];
    }

    const ctx = getQueryContext(text, offset);
    let suggestions: Suggestion[] = [];
    const wordAtCursor = getWordAtCursor(text, offset);
    const contextObject = await resolveContextObject(text, offset, metadata);

    switch (ctx.type) {
        case 'from_object': {
            if (ctx.partial.length < 1) { break; }
            const scoped = extractScopedFromInfo(text, offset);
            if (scoped && scoped.depth > 0) {
                suggestions = await getSubqueryFromSuggestions(text, scoped, ctx.partial, metadata);
                break;
            }
            const objects = await metadata.getObjectList();
            const lower = ctx.partial.toLowerCase();
            const isCompletedObject = wordAtCursor.word.length > 0
                && wordAtCursor.end === offset
                && objects.some(name => name.toLowerCase() === wordAtCursor.word.toLowerCase());
            if (isCompletedObject) { break; }
            const starts = objects.filter(n => n.toLowerCase().startsWith(lower));
            const contains = objects.filter(n => !n.toLowerCase().startsWith(lower) && n.toLowerCase().includes(lower));
            // Sort each group by popularity weight (descending), then alphabetically
            const byWeight = (a: string, b: string) => {
                const diff = getObjectWeight(b) - getObjectWeight(a);
                return diff !== 0 ? diff : a.localeCompare(b);
            };
            starts.sort(byWeight);
            contains.sort(byWeight);
            suggestions = [...starts, ...contains]
                .slice(0, 25)
                .map(n => ({ label: n, detail: 'SObject', insertText: n }));
            break;
        }
        case 'select_fields':
        case 'where_field':
        case 'order_by':
        case 'group_by': {
            if (ctx.partial.length < 1) { break; }
            const obj = contextObject;
            if (obj) {
                const usage: FieldUsage =
                    ctx.type === 'where_field' ? 'where'
                        : ctx.type === 'order_by' ? 'order_by'
                            : ctx.type === 'group_by' ? 'group_by'
                                : 'select';
                const dotParts = ctx.partial.split('.');
                if (dotParts.length > 1) {
                    suggestions = await getRelationshipFieldSuggestions(obj, dotParts, metadata, usage);
                } else {
                    suggestions = await getDirectFieldSuggestions(obj, ctx.partial, metadata, usage);
                }
                const isFinishedToken = wordAtCursor.word.length > 0 && wordAtCursor.end === offset;
                if (isFinishedToken) {
                    suggestions = suggestions.filter(s => s.insertText.toLowerCase() !== wordAtCursor.word.toLowerCase());
                }
            }
            break;
        }
        case 'where_value': {
            const obj = contextObject;
            if (obj) {
                // Resolve a possibly relationship-qualified field path (e.g.
                // Account.Industry on Contact) to the target object's field so its
                // picklist values are offered, not the base object's.
                const segments = ctx.field.split('.');
                const desc = await resolveRelationshipChain(obj, segments.slice(0, -1), metadata);
                if (desc) {
                    const leaf = segments[segments.length - 1].toLowerCase();
                    const field = desc.fields.find(f => f.name.toLowerCase() === leaf);
                    if (field && field.picklistValues.length > 0) {
                        suggestions = field.picklistValues.map(pv => ({
                            label: pv.label,
                            detail: pv.value,
                            insertText: `'${pv.value}'`,
                        }));
                    }
                }
            }
            // Check if we're after LIKE — offer wildcard patterns
            const beforeCursor = text.substring(0, offset).toUpperCase();
            if (/LIKE\s*$/i.test(beforeCursor) || /LIKE\s+'[^']*$/i.test(beforeCursor)) {
                const wildcardSuggestions: Suggestion[] = [
                    { label: "'%value%'", detail: 'Contains', insertText: "'%'" },
                    { label: "'value%'", detail: 'Starts with', insertText: "''" },
                    { label: "'%value'", detail: 'Ends with', insertText: "'%'" },
                ];
                suggestions = [...wildcardSuggestions, ...suggestions];
            }
            break;
        }
        case 'where_operator': {
            const operators = [
                { label: '=', detail: 'Equals', insertText: '= ' },
                { label: '!=', detail: 'Not equals', insertText: '!= ' },
                { label: '<', detail: 'Less than', insertText: '< ' },
                { label: '>', detail: 'Greater than', insertText: '> ' },
                { label: '<=', detail: 'Less than or equal', insertText: '<= ' },
                { label: '>=', detail: 'Greater than or equal', insertText: '>= ' },
                { label: 'LIKE', detail: 'Pattern match (%, _)', insertText: 'LIKE ' },
                { label: 'IN', detail: 'In list of values', insertText: 'IN (' },
                { label: 'NOT IN', detail: 'Not in list', insertText: 'NOT IN (' },
                { label: 'INCLUDES', detail: 'Multi-select includes', insertText: 'INCLUDES (' },
                { label: 'EXCLUDES', detail: 'Multi-select excludes', insertText: 'EXCLUDES (' },
            ];
            const lower = ctx.partial.toLowerCase();
            suggestions = lower.length > 0
                ? operators.filter(op => op.label.toLowerCase().startsWith(lower))
                : operators;
            break;
        }
        case 'having': {
            const havingSuggestions: Suggestion[] = [
                { label: 'COUNT()', detail: 'Aggregate', insertText: 'COUNT()' },
                { label: 'COUNT(Id)', detail: 'Count of Id', insertText: 'COUNT(Id)' },
                { label: 'SUM()', detail: 'Aggregate', insertText: 'SUM(' },
                { label: 'AVG()', detail: 'Aggregate', insertText: 'AVG(' },
                { label: 'MIN()', detail: 'Aggregate', insertText: 'MIN(' },
                { label: 'MAX()', detail: 'Aggregate', insertText: 'MAX(' },
                { label: 'COUNT_DISTINCT()', detail: 'Aggregate', insertText: 'COUNT_DISTINCT(' },
            ];
            const lower = ctx.partial.toLowerCase();
            suggestions = lower.length > 0
                ? havingSuggestions.filter(s => s.label.toLowerCase().startsWith(lower))
                : havingSuggestions;
            // Also suggest fields from the object
            const obj = extractFromObject(text);
            const ctxObj = contextObject || obj;
            if (ctxObj && ctx.partial.length >= 1) {
                const fieldSugs = await getDirectFieldSuggestions(ctxObj, ctx.partial, metadata, 'group_by');
                suggestions = [...suggestions, ...fieldSugs];
            }
            break;
        }
        default: {
            if (ctx.type !== 'unknown') { break; }
            suggestions = getKeywordSuggestions(text, offset);
            break;
        }
    }

    return suggestions;
}

export async function getSubqueryFromSuggestions(
    text: string,
    scoped: ScopedFromInfo,
    partial: string,
    metadata: MetadataProvider
): Promise<Suggestion[]> {
    const parentScoped = extractScopedFromInfo(text, scoped.selectIndex);
    let parentObj: string | undefined;
    if (parentScoped) {
        parentObj = await resolveScopeObject(parentScoped, text, metadata, new Map<number, string | undefined>());
    } else {
        // While users type an incomplete inner query (e.g. missing `)`),
        // scope extraction for the parent may fail. Fall back to the last FROM token.
        parentObj = extractLastFromObject(text);
    }
    if (!parentObj) {
        return [];
    }

    const parentDescribe = await metadata.describeSObject(parentObj);
    if (!parentDescribe) {
        return [];
    }

    const lower = partial.toLowerCase();
    const relationships = parentDescribe.childRelationships
        .filter(rel => !!rel.relationshipName)
        .map(rel => ({ relationshipName: rel.relationshipName!, childSObject: rel.childSObject }));

    const scored = relationships.map(r => {
        const relLower = r.relationshipName.toLowerCase();
        const childLower = r.childSObject.toLowerCase();
        let score = -1;
        if (relLower.startsWith(lower)) {
            score = 0;
        } else if (childLower.startsWith(lower)) {
            score = 1;
        } else if (relLower.includes(lower)) {
            score = 2;
        } else if (childLower.includes(lower)) {
            score = 3;
        }
        return { ...r, score };
    }).filter(r => r.score >= 0);

    scored.sort((a, b) => {
        if (a.score !== b.score) {
            return a.score - b.score;
        }
        return a.relationshipName.localeCompare(b.relationshipName);
    });

    return scored
        .slice(0, 25)
        .map(r => ({
            label: r.relationshipName,
            detail: `Child relationship (${r.childSObject})`,
            insertText: r.relationshipName,
        }));
}

function extractLastFromObject(text: string): string | undefined {
    const re = /\bFROM\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
    let m: RegExpExecArray | null = null;
    let last: string | undefined;
    while ((m = re.exec(text)) !== null) {
        last = m[1];
    }
    return last;
}

async function resolveContextObject(
    text: string,
    offset: number,
    metadata: MetadataProvider
): Promise<string | undefined> {
    const scoped = extractScopedFromInfo(text, offset);
    if (!scoped) {
        // Inside a subquery scope with no resolved FROM yet: avoid falling back
        // to outer-object fields, which creates misleading suggestions.
        if (getQueryDepthAtOffset(text, offset) > 0) {
            return undefined;
        }
        return extractFromObject(text);
    }
    const memo = new Map<number, string | undefined>();
    return resolveScopeObject(scoped, text, metadata, memo);
}

async function resolveScopeObject(
    scoped: ScopedFromInfo,
    text: string,
    metadata: MetadataProvider,
    memo: Map<number, string | undefined>
): Promise<string | undefined> {
    if (memo.has(scoped.selectIndex)) {
        return memo.get(scoped.selectIndex);
    }

    if (scoped.depth <= 0) {
        memo.set(scoped.selectIndex, scoped.fromName);
        return scoped.fromName;
    }

    const parentScoped = extractScopedFromInfo(text, scoped.selectIndex);
    if (!parentScoped) {
        memo.set(scoped.selectIndex, scoped.fromName);
        return scoped.fromName;
    }
    const parentObj = await resolveScopeObject(parentScoped, text, metadata, memo);
    if (!parentObj) {
        memo.set(scoped.selectIndex, scoped.fromName);
        return scoped.fromName;
    }

    const parentDescribe = await metadata.describeSObject(parentObj);
    const childRel = parentDescribe?.childRelationships.find(rel =>
        rel.relationshipName?.toLowerCase() === scoped.fromName.toLowerCase()
    );
    const resolved = childRel?.childSObject || scoped.fromName;
    memo.set(scoped.selectIndex, resolved);
    return resolved;
}

async function getRelationshipFieldSuggestions(
    obj: string,
    dotParts: string[],
    metadata: MetadataProvider,
    usage: FieldUsage,
): Promise<Suggestion[]> {
    const resolved = await resolveRelationshipChain(obj, dotParts.slice(0, -1), metadata);
    if (!resolved) { return []; }

    const fieldPartial = dotParts[dotParts.length - 1].toLowerCase();
    const prefix = dotParts.slice(0, -1).join('.') + '.';
    const usable = resolved.fields.filter(f => isFieldUsableIn(f, usage));
    const starts = usable.filter(f => !fieldPartial || f.name.toLowerCase().startsWith(fieldPartial));
    const contains = fieldPartial
        ? usable.filter(f => !f.name.toLowerCase().startsWith(fieldPartial) && f.name.toLowerCase().includes(fieldPartial))
        : [];

    const suggestions: Suggestion[] = [...starts, ...contains]
        .slice(0, 20)
        .map(f => {
            const full = prefix + f.name;
            return {
                label: f.name,
                detail: `${f.type}${f.nillable ? ' (nullable)' : ''} (${resolved.name})`,
                insertText: full,
            };
        });

    const relFields = resolved.fields.filter(f =>
        f.relationshipName &&
        (!fieldPartial || f.relationshipName.toLowerCase().startsWith(fieldPartial) || f.relationshipName.toLowerCase().includes(fieldPartial))
    );
    for (const f of relFields.slice(0, 5)) {
        const full = prefix + f.relationshipName! + '.';
        suggestions.push({
            label: `${f.relationshipName!}.`,
            detail: `-> ${f.referenceTo.join(', ')}`,
            insertText: full,
        });
    }

    return suggestions;
}

async function getDirectFieldSuggestions(
    obj: string,
    partial: string,
    metadata: MetadataProvider,
    usage: FieldUsage,
): Promise<Suggestion[]> {
    const desc = await metadata.describeSObject(obj);
    if (!desc) { return []; }

    const lower = partial.toLowerCase();
    const usable = desc.fields.filter(f => isFieldUsableIn(f, usage));
    const starts = usable.filter(f => !partial || f.name.toLowerCase().startsWith(lower));
    const contains = partial
        ? usable.filter(f => !f.name.toLowerCase().startsWith(lower) && f.name.toLowerCase().includes(lower))
        : [];

    const suggestions: Suggestion[] = [...starts, ...contains]
        .slice(0, 20)
        .map(f => ({
            label: f.name,
            detail: `${f.type}${f.nillable ? ' (nullable)' : ''}`,
            insertText: f.name,
        }));

    if (partial.length >= 1) {
        const relFields = desc.fields.filter(f =>
            f.relationshipName &&
            (f.relationshipName.toLowerCase().startsWith(lower) || f.relationshipName.toLowerCase().includes(lower))
        );
        for (const f of relFields.slice(0, 5)) {
            const full = f.relationshipName! + '.';
            if (!suggestions.some(s => s.insertText === full)) {
                suggestions.push({
                    label: toRelationshipDisplayLabel(full),
                    detail: `-> ${f.referenceTo.join(', ')}`,
                    insertText: full,
                });
            }
        }
    }

    return suggestions;
}

function getKeywordSuggestions(text: string, offset: number): Suggestion[] {
    const upper = text.toUpperCase();
    let kw: string[] = [];

    if (!upper.includes('SELECT')) {
        kw = ['SELECT'];
    } else if (!upper.includes('FROM')) {
        kw = ['FROM', 'FIELDS(ALL)', 'FIELDS(STANDARD)', 'FIELDS(CUSTOM)', 'COUNT()'];
    } else if (!upper.includes('WHERE')) {
        kw = ['WHERE', 'ORDER BY', 'GROUP BY', 'LIMIT', 'OFFSET'];
    } else {
        kw = ['AND', 'OR', 'NOT', 'IN', 'LIKE', 'ORDER BY', 'GROUP BY',
              'HAVING', 'LIMIT', 'OFFSET', 'ASC', 'DESC',
              'TODAY', 'YESTERDAY', 'LAST_N_DAYS:', 'NULL', 'TRUE', 'FALSE'];
    }

    const partial = text.substring(0, offset).match(/[a-zA-Z_]\w*$/)?.[0]?.toLowerCase() || '';
    if (partial.length >= 1) {
        kw = kw.filter(k => k.toLowerCase().startsWith(partial));
    } else {
        kw = [];
    }

    return kw.map(k => ({ label: k, detail: 'keyword', insertText: k }));
}
