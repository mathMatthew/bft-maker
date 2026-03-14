import * as fs from "node:fs";
import * as yaml from "js-yaml";
import type { Manifest, MetricPropagation, PropagationEdge, TimeDeclaration } from "./types.js";
import { DEFAULT_PLACEHOLDER_LABELS } from "./types.js";

/** What the YAML parser produces before normalization — metric can be a list. */
interface RawPropagation {
  metric: string | string[];
  path: PropagationEdge[];
}

/** Expand propagations where metric is an array into individual entries. */
function expandPropagations(raw: RawPropagation[]): MetricPropagation[] {
  const result: MetricPropagation[] = [];
  for (const prop of raw) {
    const names = Array.isArray(prop.metric) ? prop.metric : [prop.metric];
    for (const name of names) {
      result.push({ metric: name, path: prop.path.map((e) => ({ ...e })) });
    }
  }
  return result;
}

/**
 * Parse a YAML string into a Manifest. The result is structurally unvalidated —
 * call validate() on the returned manifest to check semantic correctness.
 *
 * TODO: Add runtime structural validation (e.g. via zod) to catch type mismatches
 * (wrong field types, missing required fields, extra keys) before they cause
 * downstream runtime errors. Currently only semantic validation exists via validate().
 */
export function parseManifest(yamlString: string): Manifest {
  const raw = yaml.load(yamlString) as Record<string, unknown>;
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid manifest: expected a YAML object");
  }
  const manifest: Manifest = {
    entities: (raw.entities ?? []) as Manifest["entities"],
    relationships: (raw.relationships ?? []) as Manifest["relationships"],
    propagations: expandPropagations((raw.propagations ?? []) as RawPropagation[]),
    bft_tables: (raw.bft_tables ?? []) as Manifest["bft_tables"],
  };
  if (raw.placeholder_labels) {
    manifest.placeholder_labels = {
      ...DEFAULT_PLACEHOLDER_LABELS,
      ...raw.placeholder_labels,
    };
  }
  if (raw.time) {
    const t = raw.time as Record<string, unknown>;
    if (typeof t !== "object" || t === null) {
      throw new Error("Invalid manifest: time must be an object");
    }
    if (typeof t.entity !== "string" || !t.entity) {
      throw new Error("Invalid manifest: time.entity must be a non-empty string");
    }
    if (typeof t.column !== "string" || !t.column) {
      throw new Error("Invalid manifest: time.column must be a non-empty string");
    }
    if (typeof t.granularity !== "string" || !t.granularity) {
      throw new Error("Invalid manifest: time.granularity must be a non-empty string");
    }
    manifest.time = t as unknown as TimeDeclaration;
  }
  return manifest;
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
