import * as clack from "@clack/prompts";
import type { BftTable } from "../../manifest/types.js";
import type { WizardState } from "../state.js";
import { allMetricDefs } from "../state.js";

/* ------------------------------------------------------------------ */
/*  Step 4: BFT table composition                                     */
/* ------------------------------------------------------------------ */

async function promptTable(
  state: WizardState,
  existingNames: string[],
): Promise<BftTable | null> {
  const name = await clack.text({
    message: "Table name (or leave empty to finish)",
    placeholder: "e.g. department_financial, student_experience",
    validate: (val) => {
      if (!val || val === "") return undefined;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(val)) {
        return "Must be a valid identifier";
      }
      if (existingNames.includes(val)) {
        return `Table "${val}" already exists`;
      }
      return undefined;
    },
  });

  if (clack.isCancel(name) || name === "") return null;

  const entityOptions = state.entities.map((e) => ({
    value: e.name,
    label: `${e.name} (${e.role})`,
  }));

  const entities = await clack.multiselect({
    message: `Which entities define the grain of ${name}?`,
    options: entityOptions,
    required: true,
  });

  if (clack.isCancel(entities)) return null;

  const metricDefs = allMetricDefs(state);
  const metricOptions = metricDefs.map((m) => ({
    value: m.name,
    label: `${m.name} (${m.type}, ${m.nature})`,
  }));

  const metrics = await clack.multiselect({
    message: `Which metrics to include in ${name}?`,
    options: metricOptions,
    required: true,
  });

  if (clack.isCancel(metrics)) return null;

  return {
    name: name as string,
    entities: entities as string[],
    metrics: metrics as string[],
  };
}

export async function runTablesStep(state: WizardState): Promise<boolean> {
  clack.intro("Step 4: Compose BFT tables");
  clack.log.info(
    "Define one or more BFT tables. Each table specifies which entities\n" +
    "(grain) and which metrics to include.",
  );

  while (true) {
    const table = await promptTable(
      state,
      state.bftTables.map((t) => t.name),
    );
    if (table === null) {
      if (state.bftTables.length === 0) {
        clack.log.warning("You need at least 1 BFT table.");
        continue;
      }
      break;
    }
    state.bftTables.push(table);
    clack.log.success(
      `Added table: ${table.name} (${table.entities.length} entities, ${table.metrics.length} metrics)`,
    );
  }

  return true;
}
