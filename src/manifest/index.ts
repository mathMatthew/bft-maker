export type {
  Manifest,
  Entity,
  MetricDef,
  Relationship,
  PropagationEdge,
  MetricPropagation,
  BftTable,
  Strategy,
  PlaceholderLabels,
} from "./types.js";
export { VALID_STRATEGIES, DEFAULT_PLACEHOLDER_LABELS } from "./types.js";

export { validate } from "./validate.js";
export type { ValidationError } from "./validate.js";

export { estimateRows, estimateTableRows, fanOut } from "./estimate.js";
export type { RowEstimate } from "./estimate.js";

export {
  parseManifest,
  serializeManifest,
  loadManifest,
  saveManifest,
} from "./yaml.js";
