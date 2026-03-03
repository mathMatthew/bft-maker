import * as clack from "@clack/prompts";
import { settings } from "@clack/core";
import type { WizardState } from "../state.js";
import { cellsNeedingWeights } from "../state.js";

/* ------------------------------------------------------------------ */
/*  Step 3: Weight definitions                                        */
/* ------------------------------------------------------------------ */

export async function runWeightsStep(state: WizardState): Promise<boolean> {
  const cells = cellsNeedingWeights(state);

  if (cells.length === 0) {
    clack.log.info("No allocation or sum/sum strategies — skipping weight definitions.");
    return true;
  }

  clack.intro("Step 3: Define weight columns");
  clack.log.info(
    "For each allocation or sum/sum strategy, specify the weight column name.\n" +
    "This column should exist in the relationship table.",
  );

  for (const cell of cells) {
    const strategyLabel = cell.value === "allocation" ? "allocation" : "sum/sum";

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
