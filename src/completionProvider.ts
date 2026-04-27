import * as vscode from 'vscode';
import { getQueryContext, extractFromObject } from './soqlParser';
import { MetadataProvider } from './metadataProvider';

/**
 * Provides inline autocomplete and suggestions for SOQL queries.
 * - After SELECT: suggests field names from the described object
 * - After FROM: suggests SObject names
 * - After WHERE / AND / OR: suggests field names
 * - After ORDER BY / GROUP BY: suggests field names
 */
export class SoqlCompletionProvider implements vscode.CompletionItemProvider {
    private metadata: MetadataProvider;

    constructor(metadata: MetadataProvider) {
        this.metadata = metadata;
    }

    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
        _context: vscode.CompletionContext
    ): Promise<vscode.CompletionItem[]> {
        const text = document.getText();
        const offset = document.offsetAt(position);
        const ctx = getQueryContext(text, offset);

        switch (ctx.type) {
            case 'from_object':
                return this.getObjectCompletions(ctx.partial);

            case 'select_fields':
            case 'where_field':
            case 'order_by':
            case 'group_by':
                return this.getFieldCompletions(text, ctx.partial);

            case 'where_operator':
                return this.getOperatorCompletions(ctx.partial);

            case 'where_value':
                return this.getValueCompletions(text, ctx.field);

            case 'having':
                return this.getHavingCompletions(text, ctx.partial);

            default:
                return this.getKeywordCompletions();
        }
    }

    private async getObjectCompletions(partial: string): Promise<vscode.CompletionItem[]> {
        if (partial.length < 1) { return []; } // require at least 1 char to search objects
        const objects = await this.metadata.getObjectList();
        const lower = partial.toLowerCase();

        // Prioritize startsWith, then contains
        const starts: string[] = [];
        const contains: string[] = [];
        for (const name of objects) {
            const nl = name.toLowerCase();
            if (nl.startsWith(lower)) { starts.push(name); }
            else if (nl.includes(lower)) { contains.push(name); }
        }
        const matched = [...starts, ...contains].slice(0, 30);

        return matched.map((name, i) => {
            const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Class);
            item.detail = 'SObject';
            item.insertText = name;
            item.sortText = String(i).padStart(4, '0');
            return item;
        });
    }

    private async getFieldCompletions(queryText: string, partial: string): Promise<vscode.CompletionItem[]> {
        const objectName = extractFromObject(queryText);
        if (!objectName) {
            return [];
        }

        const describe = await this.metadata.describeSObject(objectName);
        if (!describe) {
            return [];
        }

        const lower = partial.toLowerCase();

        // Prioritize: startsWith first, then contains, cap at 25
        const starts: typeof describe.fields = [];
        const contains: typeof describe.fields = [];
        for (const field of describe.fields) {
            const fl = field.name.toLowerCase();
            if (!partial) { starts.push(field); }
            else if (fl.startsWith(lower)) { starts.push(field); }
            else if (fl.includes(lower)) { contains.push(field); }
        }
        const matched = [...starts, ...contains].slice(0, 25);

        const items: vscode.CompletionItem[] = matched.map((field, i) => {
            const item = new vscode.CompletionItem(field.name, vscode.CompletionItemKind.Field);
            item.detail = `${field.type}${field.nillable ? ' (nullable)' : ''}`;
            item.documentation = new vscode.MarkdownString(
                `**${field.label}**\n\n` +
                `- Type: \`${field.type}\`\n` +
                `- API Name: \`${field.name}\`\n` +
                (field.referenceTo.length > 0
                    ? `- References: ${field.referenceTo.join(', ')}\n`
                    : '') +
                (field.relationshipName
                    ? `- Relationship: \`${field.relationshipName}\`\n`
                    : '')
            );
            item.insertText = field.name;
            item.sortText = String(i).padStart(4, '0');
            return item;
        });

        // Only show relationships when partial is >= 2 chars
        if (partial.length >= 2) {
            for (const field of describe.fields) {
                if (field.relationshipName && field.referenceTo.length > 0) {
                    const relName = field.relationshipName;
                    if (!relName.toLowerCase().startsWith(lower) && !relName.toLowerCase().includes(lower)) {
                        continue;
                    }
                    const item = new vscode.CompletionItem(
                        relName + '.',
                        vscode.CompletionItemKind.Reference
                    );
                    item.detail = `Relationship > ${field.referenceTo.join(', ')}`;
                    item.insertText = relName + '.';
                    item.command = {
                        command: 'editor.action.triggerSuggest',
                        title: 'Trigger Suggest',
                    };
                    items.push(item);
                }
            }

            for (const child of describe.childRelationships) {
                const relName = child.relationshipName;
                if (!relName.toLowerCase().startsWith(lower) && !relName.toLowerCase().includes(lower)) {
                    continue;
                }
                const item = new vscode.CompletionItem(
                    `(SELECT ... FROM ${relName})`,
                    vscode.CompletionItemKind.Snippet
                );
                item.detail = `Child: ${child.childSObject}`;
                item.insertText = new vscode.SnippetString(
                    `(SELECT \${1:Id} FROM ${relName})`
                );
                items.push(item);
            }
        }

        return items;
    }

    private async getValueCompletions(queryText: string, fieldName: string): Promise<vscode.CompletionItem[]> {
        const objectName = extractFromObject(queryText);
        if (!objectName) { return []; }

        const describe = await this.metadata.describeSObject(objectName);
        if (!describe) { return []; }

        const field = describe.fields.find(
            f => f.name.toLowerCase() === fieldName.toLowerCase()
        );
        if (!field || field.picklistValues.length === 0) {
            return [];
        }

        return field.picklistValues.map(pv => {
            const item = new vscode.CompletionItem(
                pv.label,
                vscode.CompletionItemKind.EnumMember
            );
            item.detail = pv.value;
            item.insertText = `'${pv.value}'`;
            return item;
        });
    }

    private getKeywordCompletions(): vscode.CompletionItem[] {
        const keywords = [
            'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'LIKE',
            'ORDER BY', 'GROUP BY', 'HAVING', 'LIMIT', 'OFFSET',
            'ASC', 'DESC', 'NULLS FIRST', 'NULLS LAST',
            'COUNT()', 'COUNT(Id)', 'AVG(', 'SUM(', 'MIN(', 'MAX(',
            'FIELDS(ALL)', 'FIELDS(STANDARD)', 'FIELDS(CUSTOM)',
            'TODAY', 'YESTERDAY', 'LAST_N_DAYS:',
        ];

        return keywords.map(kw => {
            const item = new vscode.CompletionItem(kw, vscode.CompletionItemKind.Keyword);
            item.insertText = kw;
            return item;
        });
    }

    private getOperatorCompletions(partial: string): vscode.CompletionItem[] {
        const operators = [
            { label: '=', detail: 'Equals' },
            { label: '!=', detail: 'Not equals' },
            { label: '<', detail: 'Less than' },
            { label: '>', detail: 'Greater than' },
            { label: '<=', detail: 'Less than or equal' },
            { label: '>=', detail: 'Greater than or equal' },
            { label: 'LIKE', detail: 'Pattern match (%, _)' },
            { label: 'IN', detail: 'In list of values' },
            { label: 'NOT IN', detail: 'Not in list' },
            { label: 'INCLUDES', detail: 'Multi-select includes' },
            { label: 'EXCLUDES', detail: 'Multi-select excludes' },
        ];

        const lower = partial.toLowerCase();
        const filtered = lower.length > 0
            ? operators.filter(op => op.label.toLowerCase().startsWith(lower))
            : operators;

        return filtered.map((op, i) => {
            const item = new vscode.CompletionItem(op.label, vscode.CompletionItemKind.Operator);
            item.detail = op.detail;
            item.insertText = op.label + ' ';
            item.sortText = String(i).padStart(4, '0');
            return item;
        });
    }

    private async getHavingCompletions(queryText: string, partial: string): Promise<vscode.CompletionItem[]> {
        const aggregates = [
            { label: 'COUNT()', detail: 'Aggregate' },
            { label: 'COUNT(Id)', detail: 'Count of Id' },
            { label: 'SUM(', detail: 'Aggregate' },
            { label: 'AVG(', detail: 'Aggregate' },
            { label: 'MIN(', detail: 'Aggregate' },
            { label: 'MAX(', detail: 'Aggregate' },
            { label: 'COUNT_DISTINCT(', detail: 'Aggregate' },
        ];

        const lower = partial.toLowerCase();
        const items: vscode.CompletionItem[] = [];

        const filteredAggs = lower.length > 0
            ? aggregates.filter(a => a.label.toLowerCase().startsWith(lower))
            : aggregates;
        for (const [i, agg] of filteredAggs.entries()) {
            const item = new vscode.CompletionItem(agg.label, vscode.CompletionItemKind.Function);
            item.detail = agg.detail;
            item.insertText = agg.label;
            item.sortText = String(i).padStart(4, '0');
            items.push(item);
        }

        // Also suggest fields
        const fieldItems = await this.getFieldCompletions(queryText, partial);
        items.push(...fieldItems);

        return items;
    }
}
