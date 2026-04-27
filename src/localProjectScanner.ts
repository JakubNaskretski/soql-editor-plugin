import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SObjectDescribe, SObjectField } from './sfCliService';

/**
 * Scans the local SFDX project directory structure for object/field metadata.
 *
 * Standard Salesforce DX layout:
 *   force-app/main/default/objects/<ObjectName>/
 *     ├── <ObjectName>.object-meta.xml
 *     └── fields/
 *         ├── FieldA__c.field-meta.xml
 *         └── FieldB__c.field-meta.xml
 *
 * Custom objects also live under the same structure.
 */
export class LocalProjectScanner {
    private outputChannel: vscode.OutputChannel;

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
    }

    /**
     * Find all SFDX project roots in the workspace (directories containing sfdx-project.json).
     */
    findProjectRoots(): string[] {
        const roots: string[] = [];
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) { return roots; }

        for (const folder of workspaceFolders) {
            const sfdxConfig = path.join(folder.uri.fsPath, 'sfdx-project.json');
            if (fs.existsSync(sfdxConfig)) {
                roots.push(folder.uri.fsPath);
            }
        }
        return roots;
    }

    /**
     * Get all object names found in the local project.
     */
    getLocalObjectNames(): string[] {
        const objectDirs = this.findObjectDirs();
        return objectDirs.map(d => path.basename(d));
    }

    /**
     * Read field definitions from local XML files for a specific object.
     * Returns undefined if the object isn't found in the local project.
     */
    describeFromLocal(objectName: string): SObjectDescribe | undefined {
        const objectDirs = this.findObjectDirs();
        const objectDir = objectDirs.find(
            d => path.basename(d).toLowerCase() === objectName.toLowerCase()
        );

        if (!objectDir) { return undefined; }

        const fieldsDir = path.join(objectDir, 'fields');
        const fields: SObjectField[] = [];

        // Always include standard fields that won't be in the local project
        fields.push(...this.getStandardFields());

        if (fs.existsSync(fieldsDir)) {
            const fieldFiles = fs.readdirSync(fieldsDir)
                .filter(f => f.endsWith('.field-meta.xml'));

            for (const file of fieldFiles) {
                const filePath = path.join(fieldsDir, file);
                try {
                    const field = this.parseFieldXml(filePath);
                    if (field) { fields.push(field); }
                } catch (err: any) {
                    this.outputChannel.appendLine(`Error parsing ${filePath}: ${err.message}`);
                }
            }
        }

        const resolvedName = path.basename(objectDir);

        return {
            name: resolvedName,
            label: resolvedName.replace(/__c$/, '').replace(/_/g, ' '),
            fields,
            childRelationships: [],
        };
    }

    /**
     * Parse a single .field-meta.xml file into an SObjectField.
     */
    private parseFieldXml(filePath: string): SObjectField | undefined {
        const content = fs.readFileSync(filePath, 'utf-8');

        const fullName = this.extractXmlValue(content, 'fullName')
            || path.basename(filePath).replace('.field-meta.xml', '');
        const label = this.extractXmlValue(content, 'label') || fullName;
        const type = this.extractXmlValue(content, 'type') || 'Text';
        const required = this.extractXmlValue(content, 'required') === 'true';
        const referenceTo = this.extractXmlValue(content, 'referenceTo');
        const relationshipName = this.extractXmlValue(content, 'relationshipName');

        // Extract picklist values
        const picklistValues: { label: string; value: string }[] = [];
        const valueRegex = /<value>\s*<fullName>(.*?)<\/fullName>(?:\s*<label>(.*?)<\/label>)?[\s\S]*?<\/value>/gi;
        let match;
        while ((match = valueRegex.exec(content)) !== null) {
            picklistValues.push({
                value: match[1],
                label: match[2] || match[1],
            });
        }

        // Map SFDX field types to describe API types
        const typeMap: Record<string, string> = {
            'Text': 'string', 'LongTextArea': 'textarea', 'RichTextArea': 'textarea',
            'Number': 'double', 'Currency': 'currency', 'Percent': 'percent',
            'Checkbox': 'boolean', 'Date': 'date', 'DateTime': 'datetime',
            'Email': 'email', 'Phone': 'phone', 'Url': 'url',
            'Picklist': 'picklist', 'MultiselectPicklist': 'multipicklist',
            'Lookup': 'reference', 'MasterDetail': 'reference',
            'AutoNumber': 'string', 'Formula': 'string',
            'Summary': 'double', 'TextArea': 'textarea',
        };

        return {
            name: fullName,
            label,
            type: typeMap[type] || type.toLowerCase(),
            referenceTo: referenceTo ? [referenceTo] : [],
            relationshipName: relationshipName || null,
            picklistValues,
            nillable: !required,
            updateable: type !== 'Formula' && type !== 'AutoNumber',
            createable: type !== 'Formula' && type !== 'AutoNumber',
        };
    }

    /**
     * Standard fields present on every SObject (not in field-meta.xml files).
     */
    private getStandardFields(): SObjectField[] {
        return [
            { name: 'Id', label: 'Record ID', type: 'id', referenceTo: [], relationshipName: null, picklistValues: [], nillable: false, updateable: false, createable: false },
            { name: 'Name', label: 'Name', type: 'string', referenceTo: [], relationshipName: null, picklistValues: [], nillable: true, updateable: true, createable: true },
            { name: 'CreatedDate', label: 'Created Date', type: 'datetime', referenceTo: [], relationshipName: null, picklistValues: [], nillable: false, updateable: false, createable: false },
            { name: 'CreatedById', label: 'Created By ID', type: 'reference', referenceTo: ['User'], relationshipName: 'CreatedBy', picklistValues: [], nillable: false, updateable: false, createable: false },
            { name: 'LastModifiedDate', label: 'Last Modified Date', type: 'datetime', referenceTo: [], relationshipName: null, picklistValues: [], nillable: false, updateable: false, createable: false },
            { name: 'LastModifiedById', label: 'Last Modified By ID', type: 'reference', referenceTo: ['User'], relationshipName: 'LastModifiedBy', picklistValues: [], nillable: false, updateable: false, createable: false },
            { name: 'SystemModstamp', label: 'System Modstamp', type: 'datetime', referenceTo: [], relationshipName: null, picklistValues: [], nillable: false, updateable: false, createable: false },
            { name: 'OwnerId', label: 'Owner ID', type: 'reference', referenceTo: ['User', 'Group'], relationshipName: 'Owner', picklistValues: [], nillable: false, updateable: true, createable: true },
            { name: 'IsDeleted', label: 'Deleted', type: 'boolean', referenceTo: [], relationshipName: null, picklistValues: [], nillable: false, updateable: false, createable: false },
        ];
    }

    /**
     * Find all object directories across all SFDX package directories.
     */
    private findObjectDirs(): string[] {
        const roots = this.findProjectRoots();
        const objectDirs: string[] = [];

        for (const root of roots) {
            // Read sfdx-project.json to get packageDirectories
            const configPath = path.join(root, 'sfdx-project.json');
            let packageDirs = ['force-app'];
            try {
                const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
                if (config.packageDirectories) {
                    packageDirs = config.packageDirectories.map((p: any) => p.path);
                }
            } catch { /* use default */ }

            for (const pkgDir of packageDirs) {
                // Recursively find "objects" directories
                const searchPath = path.resolve(root, String(pkgDir));
                const rootPath = path.resolve(root);
                if (!(searchPath === rootPath || searchPath.startsWith(rootPath + path.sep))) {
                    this.outputChannel.appendLine(
                        `Skipping out-of-workspace packageDirectory path "${pkgDir}" in ${configPath}`
                    );
                    continue;
                }
                this.findObjectDirsRecursive(searchPath, objectDirs);
            }
        }

        return objectDirs;
    }

    private findObjectDirsRecursive(dir: string, result: string[], depth = 0) {
        if (depth > 10 || !fs.existsSync(dir)) { return; }
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory()) { continue; }
                const fullPath = path.join(dir, entry.name);
                if (entry.name === 'objects') {
                    // Each subdirectory is an object
                    const objectEntries = fs.readdirSync(fullPath, { withFileTypes: true });
                    for (const obj of objectEntries) {
                        if (obj.isDirectory()) {
                            result.push(path.join(fullPath, obj.name));
                        }
                    }
                } else {
                    this.findObjectDirsRecursive(fullPath, result, depth + 1);
                }
            }
        } catch { /* permission errors, etc. */ }
    }

    private extractXmlValue(xml: string, tag: string): string | undefined {
        const regex = new RegExp(`<${tag}>(.*?)</${tag}>`, 's');
        const match = regex.exec(xml);
        return match ? match[1].trim() : undefined;
    }
}
