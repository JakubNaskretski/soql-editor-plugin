/**
 * Shared relationship-traversal helpers used by BOTH suggestion engines
 * (editor `completionProvider` and sidebar `panelSuggestions`), so chain
 * resolution and polymorphic-target selection can't drift apart again.
 */
import { MetadataProvider } from './metadataProvider';
import { SObjectDescribe } from './sfCliService';

/**
 * Pick the SObject to traverse into for a (possibly polymorphic) reference
 * field. Most lookups reference a single object. For polymorphic fields
 * (Owner -> [Group, User], What -> many) we cannot know the runtime type, so
 * prefer User when present — Owner/CreatedBy/LastModifiedBy traversals are by
 * far the most common and `referenceTo[0]` is "Group" alphabetically, which
 * made `Owner.` suggest Group fields. Otherwise fall back to the first target.
 */
export function pickReferenceTarget(referenceTo: readonly string[]): string | undefined {
    if (referenceTo.length === 0) { return undefined; }
    if (referenceTo.length > 1) {
        const user = referenceTo.find(target => target.toLowerCase() === 'user');
        if (user) { return user; }
    }
    return referenceTo[0];
}

/**
 * Walk a dotted relationship chain (e.g. ["Account", "Owner"]) starting from
 * `rootObject` and return the describe of the final target object, or
 * undefined when any hop can't be resolved from cached/org metadata.
 */
export async function resolveRelationshipChain(
    rootObject: string,
    relChain: readonly string[],
    metadata: MetadataProvider,
): Promise<SObjectDescribe | undefined> {
    let currentObj: string | undefined = rootObject;
    for (const relName of relChain) {
        const desc = await metadata.describeSObject(currentObj);
        if (!desc) { return undefined; }
        const field = desc.fields.find(
            f => f.relationshipName && f.relationshipName.toLowerCase() === relName.toLowerCase()
        );
        currentObj = field ? pickReferenceTarget(field.referenceTo) : undefined;
        if (!currentObj) { return undefined; }
    }
    return metadata.describeSObject(currentObj);
}
