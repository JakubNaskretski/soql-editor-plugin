import * as vscode from 'vscode';
import { getQueryContext, extractFromObject, extractScopedFromInfo, getQueryDepthAtOffset } from './soqlParser';
import { MetadataProvider } from './metadataProvider';
import {
    SOQL_AGGREGATE_FUNCTIONS,
    SOQL_BOOLEAN_LITERALS,
    SOQL_CLAUSE_KEYWORDS,
    SOQL_DATE_LITERALS,
    SOQL_FALLBACK_OBJECTS,
    SOQL_LOGICAL_KEYWORDS,
    SOQL_MISC_FUNCTIONS,
    SOQL_OPERATORS,
    SOQL_ORDERING_KEYWORDS,
    rankByPartial,
} from './soqlCatalog';

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
                return this.getFieldCompletions(text, offset, ctx.partial);

            case 'where_operator':
                return this.getOperatorCompletions(ctx.partial);

            case 'where_value':
                return this.getValueCompletions(text, offset, ctx.field);

            case 'having':
                return this.getHavingCompletions(text, offset, ctx.partial);

            case 'order_direction':
                return this.getKeywordItems(this.filterByPartial(['ASC', 'DESC'], ctx.partial), vscode.CompletionItemKind.EnumMember);

            case 'nulls_order':
                return this.getKeywordItems(
                    this.filterByPartial(['NULLS FIRST', 'NULLS LAST'], ctx.partial),
                    vscode.CompletionItemKind.EnumMember
                );

            case 'limit_value':
                return this.getNumericSnippetCompletions('LIMIT');

            case 'offset_value':
                return this.getNumericSnippetCompletions('OFFSET');

            case 'with_clause':
                return this.getKeywordItems(
                    this.filterByPartial(['SECURITY_ENFORCED'], ctx.partial),
                    vscode.CompletionItemKind.Keyword
                );

            case 'for_clause':
                return this.getKeywordItems(this.filterByPartial(['UPDATE'], ctx.partial), vscode.CompletionItemKind.Keyword);

            case 'tail_clause':
                return this.getTailClauseCompletions(ctx.partial);

            default:
                return this.getKeywordCompletions();
        }
    }

    private async getObjectCompletions(partial: string): Promise<vscode.CompletionItem[]> {
        let objects = await this.metadata.getObjectList();
        if (objects.length === 0) {
            objects = [...SOQL_FALLBACK_OBJECTS];
        }

        const ranked = rankByPartial(objects, name => name, partial, 30);
        const matched = ranked.length > 0 || partial ? ranked : objects.slice(0, 30);

        return matched.map((name, i): vscode.CompletionItem => {
            const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Class);
            item.detail = 'SObject';
            item.insertText = name;
            item.sortText = String(i).padStart(4, '0');
            return item;
        });
    }

    private async getFieldCompletions(queryText: string, offset: number, partial: string): Promise<vscode.CompletionItem[]> {
        const objectName = await this.resolveScopedObject(queryText, offset);
        if (!objectName) {
            return [];
        }

        const describe = await this.metadata.describeSObject(objectName);
        if (!describe) {
            return [];
        }

        const lower = partial.toLowerCase();
        const matched = rankByPartial(describe.fields, field => field.name, partial, 25);
        const items: vscode.CompletionItem[] = [];
        const addedRelationshipNames = new Set<string>();

        for (const field of matched) {
            const fieldItem = new vscode.CompletionItem(field.name, vscode.CompletionItemKind.Field);
            fieldItem.detail = `${field.type}${field.nillable ? ' (nullable)' : ''}`;
            fieldItem.documentation = new vscode.MarkdownString(
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
            fieldItem.insertText = field.name;
            items.push(fieldItem);

            // Keep parent relationship traversal ranked with its foreign-key field.
            if (partial.length >= 2 && field.relationshipName && field.referenceTo.length > 0) {
                const relName = field.relationshipName;
                const relKey = relName.toLowerCase();
                const fieldMatches = !partial || field.name.toLowerCase().includes(lower);
                const relMatches = relName.toLowerCase().startsWith(lower) || relName.toLowerCase().includes(lower);
                if ((fieldMatches || relMatches) && !addedRelationshipNames.has(relKey)) {
                    const relItem = new vscode.CompletionItem(
                        relName + '.',
                        vscode.CompletionItemKind.Reference
                    );
                    relItem.detail = `Relationship > ${field.referenceTo.join(', ')}`;
                    relItem.insertText = relName + '.';
                    relItem.command = {
                        command: 'editor.action.triggerSuggest',
                        title: 'Trigger Suggest',
                    };
                    items.push(relItem);
                    addedRelationshipNames.add(relKey);
                }
            }
        }

        // Only show relationships when partial is >= 2 chars
        if (partial.length >= 2) {
            for (const field of describe.fields) {
                if (field.relationshipName && field.referenceTo.length > 0) {
                    const relName = field.relationshipName;
                    if (!relName.toLowerCase().startsWith(lower) && !relName.toLowerCase().includes(lower)) {
                        continue;
                    }
                    const relKey = relName.toLowerCase();
                    if (addedRelationshipNames.has(relKey)) {
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
                    addedRelationshipNames.add(relKey);
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

        return items.map((item, i) => {
            item.sortText = String(i).padStart(4, '0');
            return item;
        });
    }

    private async getValueCompletions(queryText: string, offset: number, fieldName: string): Promise<vscode.CompletionItem[]> {
        const objectName = await this.resolveScopedObject(queryText, offset);
        if (!objectName) { return []; }

        const describe = await this.metadata.describeSObject(objectName);
        if (!describe) { return []; }

        const field = describe.fields.find(
            f => f.name.toLowerCase() === fieldName.toLowerCase()
        );
        if (!field) {
            return this.getKeywordItems(
                [...SOQL_BOOLEAN_LITERALS, ...SOQL_DATE_LITERALS],
                vscode.CompletionItemKind.Value
            );
        }
        const items: vscode.CompletionItem[] = [];

        if (field.picklistValues.length > 0) {
            items.push(...field.picklistValues.map(pv => {
                const item = new vscode.CompletionItem(
                    pv.label,
                    vscode.CompletionItemKind.EnumMember
                );
                item.detail = pv.value;
                item.insertText = `'${pv.value}'`;
                return item;
            }));
        }

        items.push(...this.getKeywordItems([...SOQL_BOOLEAN_LITERALS], vscode.CompletionItemKind.Value));

        if (field.type === 'date' || field.type === 'datetime') {
            items.push(...this.getKeywordItems(SOQL_DATE_LITERALS, vscode.CompletionItemKind.Value));
        }

        return items.map((item, i) => {
            item.sortText = String(i).padStart(4, '0');
            return item;
        });
    }

    private getKeywordCompletions(): vscode.CompletionItem[] {
        const keywords = [
            ...SOQL_CLAUSE_KEYWORDS,
            ...SOQL_LOGICAL_KEYWORDS,
            ...SOQL_ORDERING_KEYWORDS,
            ...SOQL_AGGREGATE_FUNCTIONS,
            ...SOQL_MISC_FUNCTIONS,
            ...SOQL_DATE_LITERALS,
        ];
        return this.getKeywordItems(keywords, vscode.CompletionItemKind.Keyword);
    }

    private getOperatorCompletions(partial: string): vscode.CompletionItem[] {
        const filtered = this.filterByPartial([...SOQL_OPERATORS], partial);
        return filtered.map((op, i) => {
            const item = new vscode.CompletionItem(op, vscode.CompletionItemKind.Operator);
            item.insertText = op + ' ';
            item.sortText = String(i).padStart(4, '0');
            return item;
        });
    }

    private async getHavingCompletions(queryText: string, offset: number, partial: string): Promise<vscode.CompletionItem[]> {
        const items: vscode.CompletionItem[] = [];
        const filteredAggs = this.filterByPartial([...SOQL_AGGREGATE_FUNCTIONS], partial);
        items.push(...this.getKeywordItems(filteredAggs, vscode.CompletionItemKind.Function));
        items.push(...this.getOperatorCompletions(partial));
        items.push(...this.getKeywordItems(this.filterByPartial([...SOQL_BOOLEAN_LITERALS], partial), vscode.CompletionItemKind.Value));

        // Also suggest grouped fields
        const fieldItems = await this.getFieldCompletions(queryText, offset, partial);
        items.push(...fieldItems);

        return items.slice(0, 60).map((item, i) => {
            item.sortText = String(i).padStart(4, '0');
            return item;
        });
    }

    /**
     * Resolve the SObject name for the query scope at the given cursor offset.
     * - Top-level scope returns the FROM SObject directly.
     * - Subquery scope (depth > 0) resolves the relationship name through the
     *   parent's childRelationships to find the actual child SObject.
     * - When inside a subquery scope but the parent SObject is unknown,
     *   returns undefined to avoid suggesting fields from the wrong object.
     */
    private async resolveScopedObject(text: string, offset: number): Promise<string | undefined> {
        const scoped = extractScopedFromInfo(text, offset);
        if (!scoped) {
            if (getQueryDepthAtOffset(text, offset) > 0) {
                return undefined;
            }
            return extractFromObject(text);
        }
        if (scoped.depth <= 0) {
            return scoped.fromName;
        }
        const parentScoped = extractScopedFromInfo(text, scoped.selectIndex);
        if (!parentScoped) {
            return scoped.fromName;
        }
        const parentObj = parentScoped.depth <= 0
            ? parentScoped.fromName
            : await this.resolveScopedObject(text, parentScoped.selectIndex);
        if (!parentObj) {
            return scoped.fromName;
        }
        const parentDescribe = await this.metadata.describeSObject(parentObj);
        const childRel = parentDescribe?.childRelationships.find(
            rel => rel.relationshipName?.toLowerCase() === scoped.fromName.toLowerCase()
        );
        return childRel?.childSObject || scoped.fromName;
    }

    private getTailClauseCompletions(partial: string): vscode.CompletionItem[] {
        const tailClauses = [
            'GROUP BY',
            'HAVING',
            'ORDER BY',
            'LIMIT',
            'OFFSET',
            'WITH SECURITY_ENFORCED',
            'FOR UPDATE',
        ];
        const filtered = this.filterByPartial(tailClauses, partial);
        return this.getKeywordItems(filtered, vscode.CompletionItemKind.Keyword);
    }

    private getNumericSnippetCompletions(kind: 'LIMIT' | 'OFFSET'): vscode.CompletionItem[] {
        const defaults = kind === 'LIMIT' ? ['10', '50', '100', '200'] : ['0', '50', '100', '500'];
        return defaults.map((value, i) => {
            const item = new vscode.CompletionItem(
                value,
                vscode.CompletionItemKind.Value
            );
            item.detail = `${kind} value`;
            item.insertText = value;
            item.sortText = String(i).padStart(4, '0');
            return item;
        });
    }

    private getKeywordItems(values: readonly string[], kind: vscode.CompletionItemKind): vscode.CompletionItem[] {
        return values.map((value, i) => {
            const item = new vscode.CompletionItem(value, kind);
            item.insertText = value;
            item.sortText = String(i).padStart(4, '0');
            return item;
        });
    }

    private filterByPartial(values: readonly string[], partial: string): string[] {
        const ranked = rankByPartial(values, v => v, partial, 50);
        return ranked.length > 0 || partial ? ranked : [...values];
    }
}
