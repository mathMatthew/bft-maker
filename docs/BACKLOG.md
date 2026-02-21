# Backlog

Items discovered during PR #2 review that need investigation before or during codegen.

## 1. Reserve row counting may undercount for multi-entity tables

**Context:** `estimateTableRows` in `estimate.ts` counts reserve rows by adding the metric's *home entity* to `reserveEntities` when the metric has an elimination edge or no propagation (pure reserve). This produces one `<Reserve X>` row per entity that owns a reserve/elimination metric.

**Potential issue:** Consider `class_budget` (owned by Class) with elimination toward Student. In a Student × Class × Professor table, the reserve row is `<Reserve Class>`. But `class_budget` is also implicitly reserve for Professor (not in its propagation path). Does the generated SQL need a separate reserve mechanism for the Professor dimension of `class_budget`, or does the single `<Reserve Class>` row handle it?

The answer depends on the SQL shape the codegen produces. If the reserve row is a single row with `Professor = <Reserve Professor>` AND `Class = <Reserve Class>`, then one row handles both. If reserve rows are per-entity (one row per entity needing correction), the count might be correct but the row structure needs clarification.

**Action:** When implementing codegen, write out the SQL for a 3-entity table with mixed strategies (allocation + elimination + reserve) and verify the reserve row structure. The estimation should match whatever the SQL produces.

## 2. `student_experience` table grain surprise from multi-hop propagation

**Context:** The university reference manifest originally had `student_experience` with metrics `[tuition_paid, satisfaction_score, class_budget]`. The name suggests a student-level view, but `tuition_paid` propagates Student → Class → Professor — pulling Professor into the grain. The table silently becomes Student × Class × Professor instead of the expected Student × Class.

**Fixed in review:** Removed `tuition_paid` from `student_experience` so the grain stays Student × Class. But the underlying design question remains:

**Design question:** Should the system warn when a metric's multi-hop propagation pulls unexpected entities into a table's grain? The user might add a metric to a table not realizing its propagation path extends further than expected. Options:
- **Warn:** "Adding tuition_paid to student_experience pulls Professor into the grain (via tuition_paid's path: Student → Class → Professor). The table will be Student × Class × Professor. Continue?"
- **No warn:** The grain is derived mechanically; the user should understand their propagation paths.
- **Allow grain pinning:** Let the table declare which entities it wants in the grain, and error if a metric's path extends beyond that.

This relates to open question #14 in SCHEMA_DESIGN.md (do intermediate entities belong in the grain?). Resolve together during codegen.
