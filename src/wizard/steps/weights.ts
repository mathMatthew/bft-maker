import * as clack from "@clack/prompts";
import { settings } from "@clack/core";
import type { WizardState } from "../state.js";
import { cellsNeedingWeights } from "../state.js";
import type { DetectedModel } from "../introspect.js";

/* ------------------------------------------------------------------ */
/*  Step 3: Weight definitions                                        */
/* ------------------------------------------------------------------ */

/**
 * Find numeric columns from the junction/relationship table that connects
 * the metric's home entity to the target entity — these are weight candidates.
 */
function weightCandidateColumns(
  cell: { metricName: string; entityName: string; relationship?: string },
  state: WizardState,
  model: DetectedModel,
): string[] {
  if (!cell.relationship) return [];

  // Find the manifest Relationship by name
  const rel = state.relationships.find((r) => r.name === cell.relationship);
  if (!rel) return [];

  // Find the DetectedRelationship whose entities match rel.between (either order)
  const [a, b] = rel.between;
  const detected = model.relationships.find(
    (dr) =>
      (dr.entity1 === a && dr.entity2 === b) ||
      (dr.entity1 === b && dr.entity2 === a),
  );
  if (!detected) return [];

  // Find the junction TableInfo
  const tableInfo = model.tables.find((t) => t.name === detected.junctionTable);
  if (!tableInfo) return [];

  // Collect FK column names so we can exclude them
  const fkCols = new Set(
    model.allFKs
      .filter((fk) => fk.fromTable === detected.junctionTable)
      .map((fk) => fk.fromColumn),
  );

  // Return numeric non-FK, non-PK columns — the likely weight candidates
  return tableInfo.columns
    .filter((c) => c.isNumeric && c.name !== tableInfo.pk && !fkCols.has(c.name))
    .map((c) => c.name);
}

export async function runWeightsStep(
  state: WizardState,
  model?: DetectedModel,
): Promise<boolean> {
  const cells = cellsNeedingWeights(state);

  if (cells.length === 0) {
    clack.log.info("No allocation or sum/sum strategies — skipping weight definitions.");
    return true;
  }

  clack.log.step("Step 3: Define weight columns");
  clack.log.info(
    "For each allocation or sum/sum strategy, specify the weight column name.\n" +
    "This column should exist in the relationship table.",
  );

  for (const cell of cells) {
    const strategyLabel = cell.value === "allocation" ? "allocation" : "sum/sum";

    // Show available numeric columns from the junction table as a hint
    if (model) {
      const candidates = weightCandidateColumns(cell, state, model);
      if (candidates.length > 0) {
        clack.log.info(
          `Available numeric columns in '${cell.relationship}' table: ${candidates.join(", ")}`,
        );
      }
    }

    // Disable q→cancel alias so user can type 'q' in text input
    settings.aliases.delete("q");
    const weight = await clack.text({
      message: `Weight column for ${cell.metricName} → ${cell.entityName} (${strategyLabel})`,
      placeholder: "e.g. enrollment_share, credit_hours",
      validate: (val) => {
        if (!val || val === "") return "Weight column is required";
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(val)) {
          return "Must be a valid identifier";
        }
        return undefined;
      },
    });
    settings.aliases.set("q", "cancel");

    if (clack.isCancel(weight)) return false;

    state.weights.set(`${cell.metricName}:${cell.entityName}`, weight as string);
    clack.log.success(`${cell.metricName} → ${cell.entityName}: weight = ${weight}`);
  }

  return true;
}
