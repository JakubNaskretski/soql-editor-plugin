import * as vscode from 'vscode';
import { SfCliService } from './sfCliService';
import { MetadataProvider } from './metadataProvider';
import { validateSoqlStructure, extractFromObject, extractSelectFields } from './soqlParser';

/**
 * Provides real-time SOQL diagnostics:
 * 1. Structural validation (missing SELECT/FROM, unmatched parens, etc.)
 * 2. Field validation against org metadata (unknown fields get a warning)
 */
export class SoqlDiagnosticsProvider {
    private diagnosticCollection: vscode.DiagnosticCollection;
    private sfCli: SfCliService;
    private metadata: MetadataProvider;
    private debounceTimers = new Map<string, NodeJS.Timeout>();
    private validationGeneration = new Map<string, number>();

    constructor(sfCli: SfCliService, metadata: MetadataProvider) {
        this.sfCli = sfCli;
        this.metadata = metadata;
        this.diagnosticCollection = vscode.languages.createDiagnosticCollection('soql');
    }

    /**
     * Called on document change; debounces to avoid excessive work.
     */
    scheduleValidation(document: vscode.TextDocument) {
        if (document.languageId !== 'soql') { return; }
        const key = document.uri.toString();
        const nextGeneration = (this.validationGeneration.get(key) || 0) + 1;
        this.validationGeneration.set(key, nextGeneration);

        const existing = this.debounceTimers.get(key);
        if (existing) {
            clearTimeout(existing);
        }

        const timer = setTimeout(() => {
            this.validate(document, nextGeneration);
        }, 500);
        this.debounceTimers.set(key, timer);
    }

    async validate(document: vscode.TextDocument, generation: number) {
        const key = document.uri.toString();
        const latestGeneration = this.validationGeneration.get(key) || 0;
        if (generation !== latestGeneration) { return; }

        const text = document.getText();
        if (text.trim().length === 0) {
            if ((this.validationGeneration.get(key) || 0) === generation) {
                this.diagnosticCollection.set(document.uri, []);
            }
            return;
        }

        const diagnostics: vscode.Diagnostic[] = [];

        // 1. Structural validation
        const structErrors = validateSoqlStructure(text);
        for (const err of structErrors) {
            const range = new vscode.Range(
                err.line, err.startCol,
                err.line, err.endCol
            );
            diagnostics.push(
                new vscode.Diagnostic(range, err.message, vscode.DiagnosticSeverity.Error)
            );
        }

        // 2. Field validation (only if we have an org connected and structural parse is clean)
        // 2. Field validation (works with local project metadata even without org)
        if (structErrors.length === 0) {
            const fieldDiags = await this.validateFields(document);
            diagnostics.push(...fieldDiags);
        }

        const currentGeneration = this.validationGeneration.get(key) || 0;
        if (generation === currentGeneration) {
            this.diagnosticCollection.set(document.uri, diagnostics);
        }
    }

    private async validateFields(document: vscode.TextDocument): Promise<vscode.Diagnostic[]> {
        const text = document.getText();
        const objectName = extractFromObject(text);
        if (!objectName) { return []; }

        const describe = await this.metadata.describeSObject(objectName);
        if (!describe) {
            // Can't validate — maybe object doesn't exist
            const fromMatch = text.match(/\bFROM\s+(\w+)/i);
            if (fromMatch) {
                const idx = text.toUpperCase().indexOf(fromMatch[0].toUpperCase());
                const objStart = idx + fromMatch[0].indexOf(fromMatch[1]);
                const pos = document.positionAt(objStart);
                return [
                    new vscode.Diagnostic(
                        new vscode.Range(pos, pos.translate(0, fromMatch[1].length)),
                        `Unknown SObject: ${fromMatch[1]}`,
                        vscode.DiagnosticSeverity.Warning
                    ),
                ];
            }
            return [];
        }

        const fieldNames = new Set(describe.fields.map(f => f.name.toLowerCase()));
        const relationshipNames = new Set(
            describe.fields
                .filter(f => f.relationshipName)
                .map(f => f.relationshipName!.toLowerCase())
        );

        const selectFields = extractSelectFields(text);
        const diagnostics: vscode.Diagnostic[] = [];

        for (const fieldRef of selectFields) {
            // Skip aggregate functions, subqueries, TYPEOF, FIELDS()
            if (/^(COUNT|AVG|SUM|MIN|MAX|COUNT_DISTINCT|FIELDS)\s*\(/i.test(fieldRef)) {
                continue;
            }
            if (fieldRef.startsWith('(')) { continue; }

            // For dotted references like Account.Name, check just the first part
            const parts = fieldRef.split('.');
            const rootField = parts[0];

            if (parts.length > 1) {
                // It's a relationship traversal — check that the relationship exists
                if (!relationshipNames.has(rootField.toLowerCase())) {
                    const diag = this.findFieldInDocument(document, rootField,
                        `Unknown relationship: ${rootField} on ${describe.name}`
                    );
                    if (diag) { diagnostics.push(diag); }
                }
            } else {
                // Simple field — check it exists
                if (!fieldNames.has(rootField.toLowerCase())) {
                    const diag = this.findFieldInDocument(document, rootField,
                        `Unknown field: ${rootField} on ${describe.name}`
                    );
                    if (diag) { diagnostics.push(diag); }
                }
            }
        }

        return diagnostics;
    }

    private findFieldInDocument(
        document: vscode.TextDocument,
        fieldName: string,
        message: string
    ): vscode.Diagnostic | undefined {
        const text = document.getText();
        // Find the field in the SELECT clause
        const selectMatch = text.match(/\bSELECT\b/i);
        if (!selectMatch) { return undefined; }

        const searchStart = selectMatch.index! + selectMatch[0].length;
        const fromMatch = text.match(/\bFROM\b/i);
        const searchEnd = fromMatch ? fromMatch.index! : text.length;
        const selectClause = text.substring(searchStart, searchEnd);

        const fieldRegex = new RegExp(`\\b${this.escapeRegex(fieldName)}\\b`, 'i');
        const match = fieldRegex.exec(selectClause);
        if (!match) { return undefined; }

        const absoluteOffset = searchStart + match.index;
        const pos = document.positionAt(absoluteOffset);

        return new vscode.Diagnostic(
            new vscode.Range(pos, pos.translate(0, fieldName.length)),
            message,
            vscode.DiagnosticSeverity.Warning
        );
    }

    private escapeRegex(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    dispose() {
        this.diagnosticCollection.dispose();
        for (const timer of this.debounceTimers.values()) {
            clearTimeout(timer);
        }
        this.debounceTimers.clear();
        this.validationGeneration.clear();
    }
}
