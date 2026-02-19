import * as fs from "node:fs";
import * as yaml from "js-yaml";
import type { Manifest } from "./types.js";

/**
 * Parse a YAML string into a Manifest. The result is structurally unvalidated —
 * call validate() on the returned manifest to check semantic correctness.
 *
 * TODO: Add runtime structural validation (e.g. via zod) to catch type mismatches
 * (wrong field types, missing required fields, extra keys) before they cause
 * downstream runtime errors. Currently only semantic validation exists via validate().
 */
export function parseManifest(yamlString: string): Manifest {
  const raw = yaml.load(yamlString) as Manifest;
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid manifest: expected a YAML object");
  }
  return {
    entities: raw.entities ?? [],
    relationships: raw.relationships ?? [],
    propagations: raw.propagations ?? [],
    bft_tables: raw.bft_tables ?? [],
  };
}

export function serializeManifest(manifest: Manifest): string {
  return yaml.dump(manifest, {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
    quotingType: '"',
  });
}

export function loadManifest(filePath: string): Manifest {
  const content = fs.readFileSync(filePath, "utf-8");
  return parseManifest(content);
}

export function saveManifest(manifest: Manifest, filePath: string): void {
  const content = serializeManifest(manifest);
  fs.writeFileSync(filePath, content, "utf-8");
}
