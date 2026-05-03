/** Computes context-aware autocomplete suggestions for the sidebar editor. */
import { MetadataProvider } from './metadataProvider';
import { SObjectDescribe } from './sfCliService';
import { getQueryContext, extractFromObject } from './soqlParser';

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


/** Custom objects (__c) should rank above Service/Field Service tier objects */
const CUSTOM_OBJECT_WEIGHT = 85;

function getObjectWeight(name: string): number {
    return OBJECT_WEIGHTS[name] ?? (name.endsWith('__c') ? CUSTOM_OBJECT_WEIGHT : 0);
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

    switch (ctx.type) {
        case 'from_object': {
            if (ctx.partial.length < 1) { break; }
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
            const obj = extractFromObject(text);
            if (obj) {
                const dotParts = ctx.partial.split('.');
                if (dotParts.length > 1) {
                    suggestions = await getRelationshipFieldSuggestions(obj, dotParts, metadata);
                } else {
                    suggestions = await getDirectFieldSuggestions(obj, ctx.partial, metadata);
                }
                const isFinishedToken = wordAtCursor.word.length > 0 && wordAtCursor.end === offset;
                if (isFinishedToken) {
                    suggestions = suggestions.filter(s => s.label.toLowerCase() !== wordAtCursor.word.toLowerCase());
                }
            }
            break;
        }
        case 'where_value': {
            const obj = extractFromObject(text);
            if (obj) {
                const desc = await metadata.describeSObject(obj);
                if (desc) {
                    const field = desc.fields.find(
                        f => f.name.toLowerCase() === ctx.field.toLowerCase()
                    );
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
            if (obj && ctx.partial.length >= 1) {
                const fieldSugs = await getDirectFieldSuggestions(obj, ctx.partial, metadata);
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

async function resolveRelationshipChain(
    rootObject: string,
    relChain: string[],
    metadata: MetadataProvider,
): Promise<SObjectDescribe | undefined> {
    let currentObj = rootObject;
    for (const relName of relChain) {
        const desc = await metadata.describeSObject(currentObj);
        if (!desc) { return undefined; }
        const field = desc.fields.find(
            f => f.relationshipName && f.relationshipName.toLowerCase() === relName.toLowerCase()
        );
        if (!field || field.referenceTo.length === 0) { return undefined; }
        currentObj = field.referenceTo[0];
    }
    return metadata.describeSObject(currentObj);
}

async function getRelationshipFieldSuggestions(
    obj: string,
    dotParts: string[],
    metadata: MetadataProvider,
): Promise<Suggestion[]> {
    const resolved = await resolveRelationshipChain(obj, dotParts.slice(0, -1), metadata);
    if (!resolved) { return []; }

    const fieldPartial = dotParts[dotParts.length - 1].toLowerCase();
    const prefix = dotParts.slice(0, -1).join('.') + '.';
    const starts = resolved.fields.filter(f => !fieldPartial || f.name.toLowerCase().startsWith(fieldPartial));
    const contains = fieldPartial
        ? resolved.fields.filter(f => !f.name.toLowerCase().startsWith(fieldPartial) && f.name.toLowerCase().includes(fieldPartial))
        : [];

    const suggestions: Suggestion[] = [...starts, ...contains]
        .slice(0, 20)
        .map(f => ({
            label: prefix + f.name,
            detail: `${f.type}${f.nillable ? ' (nullable)' : ''} (${resolved.name})`,
            insertText: prefix + f.name,
        }));

    const relFields = resolved.fields.filter(f =>
        f.relationshipName &&
        (!fieldPartial || f.relationshipName.toLowerCase().startsWith(fieldPartial) || f.relationshipName.toLowerCase().includes(fieldPartial))
    );
    for (const f of relFields.slice(0, 5)) {
        suggestions.push({
            label: prefix + f.relationshipName! + '.',
            detail: `-> ${f.referenceTo.join(', ')}`,
            insertText: prefix + f.relationshipName! + '.',
        });
    }

    return suggestions;
}

async function getDirectFieldSuggestions(
    obj: string,
    partial: string,
    metadata: MetadataProvider,
): Promise<Suggestion[]> {
    const desc = await metadata.describeSObject(obj);
    if (!desc) { return []; }

    const lower = partial.toLowerCase();
    const starts = desc.fields.filter(f => !partial || f.name.toLowerCase().startsWith(lower));
    const contains = partial
        ? desc.fields.filter(f => !f.name.toLowerCase().startsWith(lower) && f.name.toLowerCase().includes(lower))
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
            if (!suggestions.some(s => s.label === f.relationshipName + '.')) {
                suggestions.push({
                    label: f.relationshipName! + '.',
                    detail: `-> ${f.referenceTo.join(', ')}`,
                    insertText: f.relationshipName! + '.',
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
