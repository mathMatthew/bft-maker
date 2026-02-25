# P3: Grain-Aware Code Generator

**Status**: Complete — PR #4 reviewed, review fixes applied
**Branch**: `feat/reference-sql`

## Goal

Generalize the code generator so that every metric is computed at its own effective grain, then reconciled to the BFT's declared grain. This enables three capabilities:

1. **Relationship metrics** — metrics that live on junctions (e.g., enrollment_grade at Student x Class)
2. **Grain tracking** — each propagation step expands the grain; the planner lazily selects the minimal computation needed for each BFT
3. **Grain-aware generation** — compute metrics at their own grain, then reconcile: summarize out entities not in the BFT, add placeholder dimensions for BFT entities not in the metric's grain

This fixes two concrete bugs: (a) the validator accepts metrics whose home entity isn't in the BFT grain but the generator can't produce SQL for them, and (b) allocation+reserve mixing computes incorrect weights because the reserve dimension inflates the base join fan-out.

## Files to Modify

| File | Change |
|------|--------|
| `src/manifest/types.ts` | Add `metrics?: MetricDef[]` to `Relationship` |
| `src/manifest/helpers.ts` | Replace `buildMetricOwnerMap` with `buildMetricHomeMap` returning grain info; update `findMetricDef` to search relationships |
| `src/manifest/validate.ts` | Use new helpers; validate relationship metric propagation; add summarization validity check; include relationship metrics in duplicate checking |
| `src/manifest/estimate.ts` | Use new helpers; handle relationship metric chains and placeholder estimation |
| `src/codegen/types.ts` | New `MetricPlan` with `home`, `computeGrain`, `reserveDimensions`, `summarizeOut`; new `GrainGroup`; updated `TablePlan` with grain groups |
| `src/codegen/planner.ts` | Grain-aware planning: compute effective grain per metric, group by grain, build per-group join chains |
| `src/codegen/generator.ts` | Per-grain-group SQL generation: scoped base joins, scoped weights, summarization step, grain-aware assembly |
| `test/codegen/generator.test.ts` | New test cases for junction metrics, summarization, allocation+reserve isolation |
| `test/manifest/validate.test.ts` | Tests for relationship metric validation rules |
| `test/manifest/estimate.test.ts` | Tests for relationship metric estimation |
| `test/manifest/yaml.test.ts` | Tests for relationship metrics in YAML round-trip |
| `data/university/manifest.yaml` | Add junction metric (enrollment_grade on Enrollment) |
| `data/university/enrollments.csv` | Add enrollment_grade column |
| `docs/spec.md` | Document relationship metrics and grain model |
| `docs/system-design.md` | Update architecture section |

## Design

### 1. Schema: `types.ts`

Add `metrics` to `Relationship`:

```typescript
export interface Relationship {
  name: string;
  between: [string, string];
  type: "many-to-many" | "many-to-one";
  estimated_links: number;
  weight_column?: string;
  metrics?: MetricDef[];
}
```

### 2. Helpers: `helpers.ts`

Replace `buildMetricOwnerMap(entities) -> Map<string, Entity>` with:

```typescript
export interface MetricHome {
  kind: "entity" | "relationship";
  name: string;          // entity or relationship name
  grain: string[];       // [entityName] or [entityA, entityB]
}

export function buildMetricHomeMap(
  entities: Entity[],
  relationships: Relationship[]
): Map<string, MetricHome>
```

Update `findMetricDef` to also search `relationship.metrics`.

Update all call sites (validate.ts, estimate.ts, planner.ts) to use `buildMetricHomeMap`. No backward-compat wrapper.

### 3. Codegen types: `codegen/types.ts`

```typescript
export interface MetricPlan {
  name: string;
  home: MetricHome;                    // where the metric lives
  nature: "additive" | "non-additive";

  /** Propagation dimensions active for this BFT, with per-hop strategy. */
  propagatedDimensions: DimensionStrategy[];

  /** The grain at which this metric is computed (home + propagation targets).
   *  May include entities not in BFT grain (to be summarized out). */
  computeGrain: string[];

  /** BFT entities not in computeGrain -- reserve treatment. */
  reserveDimensions: string[];

  /** Entities in computeGrain not in BFT grain -- aggregated out after computation. */
  summarizeOut: string[];

  /** SQL generation classification. */
  behavior: MetricBehavior;
}

export type MetricBehavior =
  | "fully_allocated"    // all propagated dims allocation, no reserve dims, no summarization
  | "sum_over_sum"       // non-additive
  | "pure_elimination"   // all propagated dims elimination, no reserve dims
  | "pure_reserve"       // no propagated dims
  | "mixed";             // any other combination

/**
 * Metrics sharing the same computeGrain are grouped for shared SQL generation.
 */
export interface GrainGroup {
  id: string;                    // CTE naming prefix
  grain: string[];               // the shared computeGrain
  joinChain: JoinLink[];         // how to join entities at this grain
  metrics: MetricPlan[];         // metrics computed at this grain
  needsSummarization: boolean;   // true if grain includes non-BFT entities
}

export interface TablePlan {
  tableName: string;
  bftGrain: string[];            // declared BFT entities
  grainGroups: GrainGroup[];     // one group per distinct computeGrain
  bftJoinChain: JoinLink[];      // join chain for full BFT grain
}
```

### 4. Planner: `codegen/planner.ts`

#### Core algorithm: compute effective grain per metric

For each metric in a BFT:

1. Start with `homeGrain` (1 entity for entity metrics, 2 for relationship metrics).
2. Walk the propagation path. At each step, the cumulative grain grows by `target_entity`.
3. **Lazy evaluation**: only include steps that add entities needed by the BFT grain, or that are intermediate hops on the way to a BFT entity.
4. The **computeGrain** = all entities traversed (home + active step targets).
5. `reserveDimensions` = BFT entities not in computeGrain.
6. `summarizeOut` = computeGrain entities not in BFT grain.
7. `propagatedDimensions` = computeGrain entities (minus home) with strategies from the path.

#### Lazy step selection examples

```
Metric A1 on A, path A->B->C->D, BFT grain {A, C}

Step 0: grain {A}
Step 1 (->B): grain {A, B} -- B not in BFT, but needed to reach C
Step 2 (->C): grain {A, B, C} -- C is in BFT. Stop.

computeGrain = {A, B, C}
summarizeOut = {B}
reserveDimensions = {}
```

```
Metric A1 on A, path A->B, BFT grain {A, B, C}

Step 0: grain {A}
Step 1 (->B): grain {A, B} -- B in BFT. Stop (C not in path).

computeGrain = {A, B}
summarizeOut = {}
reserveDimensions = {C}
```

#### Grain grouping

After computing all MetricPlans, group by `computeGrain` (same set of entities = same GrainGroup). Each group gets its own `joinChain` via `buildJoinChain`.

#### Behavior classification

```typescript
function classifyBehavior(metric): MetricBehavior {
  if (metric.nature === "non-additive") return "sum_over_sum";
  if (metric.propagatedDimensions.length === 0) return "pure_reserve";

  const strategies = new Set(metric.propagatedDimensions.map(d => d.strategy));
  if (strategies.size === 1 && strategies.has("allocation")
      && metric.reserveDimensions.length === 0) return "fully_allocated";
  if (strategies.size === 1 && strategies.has("elimination")
      && metric.reserveDimensions.length === 0) return "pure_elimination";
  return "mixed";
}
```

### 5. Generator: `codegen/generator.ts`

#### SQL structure per BFT table

```
For each GrainGroup:
  1. Base join (scoped to this group's grain entities)
  2. Weights (window functions scoped to this group)
  3. Summarization (GROUP BY to remove non-BFT entities, if needed)

Assembly:
  - UNION ALL across all grain groups
  - Each group's rows have placeholder labels for BFT dims not in the group's grain
  - Each group's rows have 0 for metrics not in the group
  - Combination rows from the full BFT join for metrics that need them
  - Elimination correction branches
  - Reserve placeholder branches
```

#### Backward compatibility

When all metrics have home entities in the BFT grain and no allocation+reserve mixing: there is exactly one GrainGroup whose grain equals the BFT grain. The generated SQL is structurally identical to current output.

#### Per-grain-group base join

Same logic as current `baseJoinSQL` but scoped to the group's grain entities. For relationship metrics, the metric column comes from the junction table alias already in the join chain.

#### Per-grain-group weights

Same window function logic as current `collectWeights` but partitioned by `home.grain` entities (may be 2 for relationship metrics).

#### Summarization step

When `group.needsSummarization`:
```sql
CREATE OR REPLACE TABLE {prefix}_{groupId}_result AS
SELECT
    [BFT-grain entity columns],
    SUM(metric) AS metric,
    ...
FROM {prefix}_{groupId}_weighted
GROUP BY [BFT-grain entity columns];
```

Only allocation survives summarization (SUM preserves correctness). Sum/sum uses weighted aggregation. Elimination and reserve cannot be summarized -- the validator rejects these.

#### Assembly

Iterates over grain groups instead of assuming one base join. When a group's grain is narrower than the BFT grain, the reserve dimensions get placeholder labels.

### 6. Validator: `validate.ts`

Updated rules:
- **Duplicate metric names**: check across both entities and relationships
- **Propagation for relationship metrics**: starting grain is both `between` entities; first hop must connect from one of those to a new entity via a different relationship
- **Summarization validity**: when a metric's home is not in the BFT grain, validate that the strategy at the boundary supports aggregation. Only allocation and sum/sum can be summarized out. Elimination and reserve at the summarization boundary -> error.
- **Unreachable metrics**: update for relationship metrics -- reachable if at least one home grain entity is in BFT grain or propagation reaches a grain entity

### 7. Estimator: `estimate.ts`

- Use `buildMetricHomeMap` instead of `buildMetricOwnerMap`
- Relationship metric chains start with both `between` entities
- Placeholder row estimation for relationship metrics: one row per junction row (`estimated_links`) rather than per entity row

### 8. Test Plan

**Additions to university manifest:**
- `enrollment_grade` (additive, float) on the Enrollment relationship
- Add it to `student_experience` table metrics (naturally at Student x Class grain)
- New BFT table `class_summary` with grain {Class, Professor} and metrics including `tuition_paid` (exercises summarization -- Student not in grain)

Add `enrollment_grade` column to `data/university/enrollments.csv`.

**New test cases:**
1. Junction metric at home grain in Student x Class BFT
2. Junction metric with propagation in Student x Class x Professor BFT
3. Summarization: `tuition_paid` in Class x Professor BFT (home entity aggregated out)
4. Allocation+reserve grain isolation (weights not inflated by reserve dim)
5. Existing tests unchanged: `department_financial` (218 rows) and `student_experience` (100 rows) pass identically

**Validation for new scenarios:**
- SUM(metric) in summarized BFT matches SUM(metric) in source
- Junction metric SUM matches source junction table SUM

## Implementation Sequence

1. Types + helpers (types.ts, helpers.ts, update all call sites)
2. Validator (relationship metric rules, summarization validity)
3. Estimator (relationship metrics in chains and placeholder estimation)
4. Codegen types (new MetricPlan, GrainGroup, TablePlan)
5. Planner (grain-aware planning with lazy evaluation and grouping)
6. Generator (per-grain-group SQL, summarization, grain-aware assembly)
7. Test data (enrollment_grade in manifest/CSV, class_summary BFT)
8. Tests (new planner tests, DuckDB integration tests, verify existing pass)
9. Docs (spec.md and system-design.md)

## Verification

1. `npm test` -- all 84 tests pass
2. New DuckDB integration tests pass for junction metrics and summarization
3. Generated SQL for existing manifests is structurally identical (same row counts, same validation results)

## PR Review Fixes (applied 2026-02-24)

Bugs:
- Escape single quotes in placeholder labels (SQL injection prevention)
- Fix `checkSummarizationValidity` to only check boundary-crossing edges, not all in-grain hops
- Add connectivity check in `buildJoinChain` (throw if BFS can't reach all entities)
- Replace single-letter `entityAlias`/`junctionAlias` with collision-safe `buildAliasMap`
- Support multiple grain groups in generator (merge non-summarization groups into one BFT pipeline, per-group pipelines for summarization groups)

Cleanup:
- Remove `.claude/task-log` from git, add to `.gitignore`
- Remove dead code: unused `summarizeOutCount` param, unreachable condition, unused variable
- Fix doc inaccuracies (branch reference, test count)
