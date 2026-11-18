import { isMap, parseDocument, type Document } from "yaml";

export const YAML_OUT = { lineWidth: 0, flowCollectionPadding: false } as const;

/** Parse YAML into a Document whose root is always a map. */
export function parseMapDocument(raw: string): Document {
  const doc: Document = parseDocument(raw) as unknown as Document;
  if (!isMap(doc.contents)) doc.contents = doc.createNode({});
  return doc;
}

/**
 * Apply a shallow patch to a YAML map, keeping every other key, comment and
 * the original ordering. `undefined` removes a key.
 */
export function patchYaml(raw: string | null, patch: Record<string, unknown>): string {
  const doc = parseMapDocument(raw ?? "");
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) doc.delete(key);
    else doc.set(key, value);
  }
  return doc.toString(YAML_OUT);
}
