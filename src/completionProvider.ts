import * as vscode from 'vscode';
import { getQueryContext, extractScopedFromInfo, isInsideStringLiteral, openStringStart, QueryContext, ScopedFromInfo } from './soqlParser';
import { MetadataProvider, typingDescribeOptions } from './metadataProvider';
import { resolveRelationshipChain } from './relationshipChain';
import { getSubqueryFromSuggestions, resolveContextObject } from './panelSuggestions';
import {
    FieldUsage,
    isFieldUsableIn,
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
        token: vscode.CancellationToken,
        _context: vscode.CompletionContext
    ): Promise<vscode.CompletionList> {
        const text = document.getText();
        const offset = document.offsetAt(position);
        const ctx = getQueryContext(text, offset);
        const items = await this.itemsFor(ctx, text, offset, token);

        // Explicit range: replace only what was typed before the caret for this
        // token — the last dot-segment of a relationship path, the digits of a
        // LIMIT, or the text since an opening quote. Without it VS Code falls back
        // to the language wordPattern, which spans dots, so `Owner.Na` became the
        // filter word and every bare field label ("Name") was filtered out.
        const range = new vscode.Range(document.positionAt(this.replaceStart(ctx, text, offset)), position);
        for (const item of items) {
            item.range = range;
        }
        // isIncomplete: field/object lists are capped and gated on the partial, so
        // VS Code must re-query on each keystroke rather than refilter a truncated
        // list client-side — that emptied (and cancelled) the session when typing
        // in front of an existing field, where quick-suggest cannot restart it.
        return new vscode.CompletionList(items, true);
    }

    private replaceStart(ctx: QueryContext, text: string, offset: number): number {
        const beforeRaw = text.substring(0, offset);
        if (ctx.type === 'limit_value' || ctx.type === 'offset_value') {
            return offset - (beforeRaw.match(/\d*$/)?.[0].length ?? 0);
        }
        if (ctx.type === 'where_value') {
            const quoteStart = openStringStart(beforeRaw, beforeRaw.length);
            if (quoteStart >= 0) { return quoteStart; }
        }
        // `unknown` has no partial (e.g. `SEL▌` before any SELECT exists): still
        // replace the identifier before the caret so keywords don't duplicate it.
        const partial = 'partial' in ctx ? ctx.partial : (beforeRaw.match(/[A-Za-z_][A-Za-z0-9_]*$/)?.[0] ?? '');
        return offset - (partial.split('.').pop() ?? '').length;
    }

    private async itemsFor(
        ctx: QueryContext,
        text: string,
        offset: number,
        token: vscode.CancellationToken
    ): Promise<vscode.CompletionItem[]> {
        switch (ctx.type) {
            case 'from_object': {
                // Inside a subquery, FROM takes a child RELATIONSHIP name
                // (e.g. `Contacts`), not an SObject name — mirror the panel.
                const scoped = extractScopedFromInfo(text, offset);
                if (scoped && scoped.depth > 0) {
                    return this.getChildRelationshipCompletions(text, scoped, ctx.partial);
                }
                return this.getObjectCompletions(ctx.partial);
            }

            case 'select_fields':
            case 'where_field':
            case 'order_by':
            case 'group_by': {
                const usage: FieldUsage =
                    ctx.type === 'where_field' ? 'where'
                        : ctx.type === 'order_by' ? 'order_by'
                            : ctx.type === 'group_by' ? 'group_by'
                                : 'select';
                return this.getFieldCompletions(text, offset, ctx.partial, usage, token);
            }

            case 'where_operator':
                return this.getOperatorCompletions(ctx.partial);

            case 'where_value':
                return this.getValueCompletions(text, offset, ctx.field);

            case 'having':
                return this.getHavingCompletions(text, offset, ctx.partial, token);

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

    private async getFieldCompletions(
        queryText: string,
        offset: number,
        partial: string,
        usage: FieldUsage = 'select',
        token?: vscode.CancellationToken
    ): Promise<vscode.CompletionItem[]> {
        const objectName = await resolveContextObject(queryText, offset, this.metadata);
        if (!objectName || token?.isCancellationRequested) {
            return [];
        }

        // Dotted partial (`Account.Owner.Na`) — resolve the relationship chain
        // and complete fields of the TARGET object. Previously the dotted text
        // was ranked against the base object's bare field names, so the editor
        // offered `Owner.` and then went silent after the dot.
        if (partial.includes('.')) {
            return this.getRelationshipFieldCompletions(objectName, partial, usage, token);
        }

        const describe = await this.metadata.describeSObject(objectName, typingDescribeOptions(token));
        if (!describe || token?.isCancellationRequested) {
            return [];
        }

        const lower = partial.toLowerCase();
        const usableFields = describe.fields.filter(f => isFieldUsableIn(f, usage));
        const matched = rankByPartial(usableFields, field => field.name, partial, 25);
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

    /**
     * Completions for a dotted relationship path (`Account.Owner.Na`). The last
     * dot-segment is the field partial; everything before it is a relationship
     * chain resolved hop-by-hop (shared with the sidebar engine). Inserted text
     * is only the final segment — VS Code's word range never spans the dot.
     */
    private async getRelationshipFieldCompletions(
        objectName: string,
        partial: string,
        usage: FieldUsage,
        token?: vscode.CancellationToken
    ): Promise<vscode.CompletionItem[]> {
        const dotParts = partial.split('.');
        const resolved = await resolveRelationshipChain(
            objectName,
            dotParts.slice(0, -1),
            this.metadata,
            () => token?.isCancellationRequested === true,
            typingDescribeOptions(token)
        );
        if (!resolved || token?.isCancellationRequested) { return []; }

        const fieldPartial = dotParts[dotParts.length - 1];
        const usableFields = resolved.fields.filter(f => isFieldUsableIn(f, usage));
        const matched = rankByPartial(usableFields, f => f.name, fieldPartial, 25);

        const items: vscode.CompletionItem[] = matched.map(field => {
            const item = new vscode.CompletionItem(field.name, vscode.CompletionItemKind.Field);
            item.detail = `${field.type}${field.nillable ? ' (nullable)' : ''} (${resolved.name})`;
            item.insertText = field.name;
            return item;
        });

        // Deeper traversal: offer the next relationship hop with a re-trigger.
        const lowerFieldPartial = fieldPartial.toLowerCase();
        const relFields = resolved.fields.filter(f =>
            f.relationshipName && f.referenceTo.length > 0 &&
            (!lowerFieldPartial ||
                f.relationshipName.toLowerCase().startsWith(lowerFieldPartial) ||
                f.relationshipName.toLowerCase().includes(lowerFieldPartial))
        );
        for (const field of relFields.slice(0, 5)) {
            const relName = field.relationshipName!;
            const item = new vscode.CompletionItem(relName + '.', vscode.CompletionItemKind.Reference);
            item.detail = `Relationship > ${field.referenceTo.join(', ')}`;
            item.insertText = relName + '.';
            item.command = {
                command: 'editor.action.triggerSuggest',
                title: 'Trigger Suggest',
            };
            items.push(item);
        }

        return items.map((item, i) => {
            item.sortText = String(i).padStart(4, '0');
            return item;
        });
    }

    /**
     * Subquery FROM takes the parent's child relationship name, not an SObject
     * name. Delegates to the engine shared with the sidebar so both surfaces
     * suggest identical child relationships.
     */
    private async getChildRelationshipCompletions(
        text: string,
        scoped: ScopedFromInfo,
        partial: string
    ): Promise<vscode.CompletionItem[]> {
        const suggestions = await getSubqueryFromSuggestions(text, scoped, partial, this.metadata);
        return suggestions.map((s, i) => {
            const item = new vscode.CompletionItem(s.label, vscode.CompletionItemKind.Reference);
            item.detail = s.detail;
            item.insertText = s.insertText;
            item.sortText = String(i).padStart(4, '0');
            return item;
        });
    }

    /**
     * Resolve a (possibly dotted) WHERE field path to its field descriptor,
     * walking relationship segments to the target object — e.g. `Account.Industry`
     * on Contact resolves to Account's Industry field, so its picklist values can
     * be offered. A plain field name resolves directly on the scoped object.
     */
    private async resolveFieldForValue(objectName: string, path: string) {
        const segments = path.split('.');
        const describe = await resolveRelationshipChain(
            objectName, segments.slice(0, -1), this.metadata, undefined, typingDescribeOptions()
        );
        if (!describe) { return undefined; }
        const leaf = segments[segments.length - 1].toLowerCase();
        return describe.fields.find(f => f.name.toLowerCase() === leaf);
    }

    private async getValueCompletions(queryText: string, offset: number, fieldName: string): Promise<vscode.CompletionItem[]> {
        const objectName = await resolveContextObject(queryText, offset, this.metadata);
        if (!objectName) { return []; }

        // Inside an open quote (`= 'Tec▌`) the value is inserted bare — the range
        // already covers the typed text since the quote and the editor may have
        // auto-closed the pair — and literals (TRUE, TODAY) don't apply.
        const beforeRaw = queryText.substring(0, offset);
        const inQuote = isInsideStringLiteral(beforeRaw, beforeRaw.length);
        const field = await this.resolveFieldForValue(objectName, fieldName);
        if (!field) {
            if (inQuote) { return []; }
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
                item.insertText = inQuote ? pv.value : `'${pv.value}'`;
                return item;
            }));
        }
        if (inQuote) {
            return items;
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

    private async getHavingCompletions(
        queryText: string,
        offset: number,
        partial: string,
        token?: vscode.CancellationToken
    ): Promise<vscode.CompletionItem[]> {
        const items: vscode.CompletionItem[] = [];
        const filteredAggs = this.filterByPartial([...SOQL_AGGREGATE_FUNCTIONS], partial);
        items.push(...this.getKeywordItems(filteredAggs, vscode.CompletionItemKind.Function));
        items.push(...this.getOperatorCompletions(partial));
        items.push(...this.getKeywordItems(this.filterByPartial([...SOQL_BOOLEAN_LITERALS], partial), vscode.CompletionItemKind.Value));

        // Also suggest fields, unfiltered: HAVING operates on aggregate results,
        // and a field can be valid INSIDE an aggregate (HAVING SUM(Amount)) while
        // being groupable=false itself.
        const fieldItems = await this.getFieldCompletions(queryText, offset, partial, 'select', token);
        items.push(...fieldItems);

        return items.slice(0, 60).map((item, i) => {
            item.sortText = String(i).padStart(4, '0');
            return item;
        });
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
