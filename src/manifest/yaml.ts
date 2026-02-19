import * as fs from "node:fs";
import * as yaml from "js-yaml";
import type { Manifest } from "./types.js";

export function parseManifest(yamlString: string): Manifest {
  const raw = yaml.load(yamlString) as Manifest;
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid manifest: expected a YAML object");
  }
  return {
    entities: raw.entities ?? [],
    relationships: raw.relationships ?? [],
    metric_clusters: raw.metric_clusters ?? [],
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
