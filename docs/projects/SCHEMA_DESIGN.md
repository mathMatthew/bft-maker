# Schema Design: Metric Propagation and Trees

## Context

During code review of P3 (manifest schema + validation), we examined whether the manifest schema has sufficient expressive power for multi-entity BFTs. This led to a series of design discoveries about how metric strategies compose across entities.

## Key Findings

### 1. Pairwise Strategy Composition

A metric belongs to one entity. On foreign rows, it needs a strategy. The question "what does this metric mean on entity X's rows?" is inherently pairwise.

For a 5-entity grain, you don't need to specify 3-way, 4-way, and 5-way combinations. The pairwise decisions along direct edges are sufficient — higher-order compositions are derived mechanically.

### 2. Topology Must Not Change Answers

**Hard constraint**: If a manifest produces a table with grain A×B×C, then rolling up to A×B must give the same answer as a separate A×B table would give directly. The user should never see different numbers for the same question depending on how many tables they chose to create.

Naive weight multiplication does NOT guarantee this. Example: Alice has $12K tuition, enrolled in 3 classes. Physics has 2 professors, others have 1. Equal allocation across all (class, professor) rows gives Physics $6K when rolled up to class level, but the pairwise Student×Class table gives Physics $4K. The professor fan-out distorts the class rollup.

### 3. Edges Are Broader Than Foreign Keys

An "edge" between entities is not limited to foreign-key relationships. An edge is any declared propagation path with a weight mechanism. Weight mechanisms include:

- **Junction table weight** — enrollment hours, assignment share (requires a relationship with data)
- **Shared dimension** — org headcount share, period revenue share (entities share a dimension like Org or Period but have no direct relationship)
- **Equal split** — no data relationship at all, just a declared intent to distribute evenly

Example: Customer and Employee have no direct relationship, but both belong to an Org. The allocation path can go Customer → Org → Employee, or a direct edge Customer → Employee with weight "org_headcount_share" can represent the same propagation.

This means unrelated entities CAN use allocation — they just need a shared dimension or declared weight to carry it.

### 4. The Tree Constraint

The entity graph for a given metric's propagation must be a tree (no cycles, no multiple paths between entities). This ensures deterministic composition of strategies along unique paths.

However, as explored further below, the tree is **not a global property of the table** — it's a property of each metric's propagation path. Different metrics can use different trees within the same table.

### 5. Direction Belongs to the Metric, Not the Edge

Initial thinking was that edges (relationships) should carry direction arrows, like Power BI. This turned out to be wrong for bft-maker.

**Why the Power BI analogy breaks down**: Power BI's arrows define filter direction for dynamic queries. Power BI never creates flat tables — it computes aggregates at query time at the correct grain. bft-maker pre-computes flat tables where every row has every metric. In a flat table, metrics propagate in ALL directions (every row has all entity dimensions), so edge-level arrows don't capture the full picture.

**The key insight**: In a flat table A×B×C with metrics from all three entities:
- a.x needs a strategy for how it appears on B and C rows
- c.x needs a strategy for how it appears on A and B rows
- Both directions must be defined — the edge between A and B carries strategies for BOTH a.x→B AND b.x→A

Each metric has a home entity and propagates outward from home through the tree. The "direction" is implicit: always outward from the metric's owner. Edges themselves are undirected; each metric implies its own direction.

### 6. Multiple Trees Per Table

Two metrics from the same entity can use different propagation paths:

- tuition_paid (Student) might allocate through Enrollment to Class
- satisfaction_score (Student) might propagate through Advising to Advisor

These are different trees. Both metrics can appear in the same BFT table. The table's grain is the union of all entities across all metrics' trees. On dimensions outside a metric's own tree, that metric defaults to reserve.

This means "one table = one tree" is too restrictive. A table can include metrics from different trees.

### 7. Elimination Also Needs Direction

Initially we thought only allocation/sum_over_sum needed direction (because they need weights), while reserve and elimination were direction-free. This is wrong for elimination.

Example: Professor Smith ($100K salary) with elimination strategy. In a Student × Class × Professor table, Smith teaches Calc (9 students) and Physics (12 students) = 21 rows each showing $100K.

GROUP BY class: Calc=$900K, Physics=$1.2M. But in a pairwise Class × Professor table, both show $100K. **Rollup invariant violated** — the student fan-out multiplied the elimination value.

Elimination needs to know WHICH dimension it's spreading across so the reserve row cancels at the right level. "Eliminate salary across classes" is different from "eliminate salary across students."

### 8. Reserve Is Direction-Free (When Pure)

Reserve means: value = 0 on all regular rows, full value only on the reserve row. Fan-out doesn't multiply zero, so adding extra dimensions to the grain doesn't change the answer. No direction needed.

**However**, this only holds when a metric is reserve for ALL foreign entities. If a metric mixes strategies (reserve for B, allocation for C), the allocation still needs a tree/path, and the reserve part interacts with it — values only appear on reserve rows for B while being allocated across C.

### 9. Trees Are Defined On Demand, Not Upfront

Putting it all together: **you don't define trees upfront.** Everything starts as reserve (no direction needed). The moment you upgrade a metric to allocation or elimination, the system asks "through what path?" and that answer defines (or reuses) a tree for that metric.

The workflow:
1. Start with all metrics using reserve (safe default, no tree needed)
2. User upgrades metric X to allocation → system asks: "allocate through what path/weight?"
3. That answer defines a propagation path for metric X
4. If another metric needs allocation along the same path, it reuses the tree
5. If it needs a different path, a new tree is created
6. Reserve metrics ride along for free — they don't participate in any tree

This is analogous to Power BI: define default relationships, then override per-measure with DAX (USERELATIONSHIP). The default handles 90% of cases; explicit overrides handle the rest.

## Proposed Architecture (Revised)

Four-layer hierarchy:

1. **Entities + Metrics** — global, shared across all tables
2. **Relationships** — the full entity graph (may have cycles, multiple paths). These are the raw material from which trees are built.
3. **Propagation paths** — per-metric (or per-group-of-metrics): which edges to use and what strategy/weight at each edge. Each path must be acyclic. Defaults to reserve (no path needed).
4. **Tables** — containers that collect metrics and determine grain. Grain = union of entities across all propagation paths of included metrics.

Mapping to manifest phases:
- Phase A = layers 1-2 (inventory: entities, metrics, relationships)
- Phase B = layer 3 (for each metric that isn't reserve: define propagation path and strategy)
- Phase C = layer 4 (topology: group metrics into tables, determine grain and row cost)

### Schema Direction

Relationships are undirected (they describe what joins exist):
```typescript
interface Relationship {
  name: string;
  between: [string, string];
  type: "many-to-many" | "many-to-one";
  estimated_links: number;
  weight_column?: string;
}
```

Propagation paths are per-metric and carry the direction implicitly (outward from metric's home entity):
```typescript
interface MetricPropagation {
  metric: string;                // metric name (home entity is known)
  path: PropagationEdge[];       // ordered edges from home outward
}

interface PropagationEdge {
  relationship: string;          // which relationship to traverse
  target_entity: string;         // which entity this edge reaches
  strategy: Strategy;            // what happens when crossing this edge
  weight?: string;               // for allocation: weight column or mechanism
}
```

Tables collect metrics and derive grain:
```typescript
interface BftTable {
  name: string;
  metrics: string[];             // which metrics to include
  // grain_entities derived from union of all metrics' propagation paths
  // estimated_rows computed from relationships and grain
}
```

## Resolved Questions

### Rollup Invariant

**Holds for all strategy combinations.** The key is that entities in a metric's propagation path get the declared strategy; entities outside the path get reserve automatically. Reserve's "zero on regular rows" property prevents fan-out corruption.

- Allocation × Allocation: values split at each hop, summing reverses each split. Correct.
- Allocation × Reserve: allocated values only appear on reserve rows of the uninvolved entity. Summing across that entity recovers the allocated value. Correct.
- Elimination × Reserve: elimination values appear on reserve rows of uninvolved entities. Fan-out of the uninvolved entity multiplies zeros. Correct.
- Reserve × Reserve: all zeros except reserve rows. Trivially correct.

### M-to-1 Handling

**No schema change needed.** M-to-1 works identically to M-to-M for strategy purposes. The "one" side is an entity if it has metrics; otherwise it's a joined column (not modeled as an entity). M-to-1 only affects `estimated_links` (same as the "many" count), not strategy logic.

### Mixed Strategies (Reserve for B, Allocation for C)

Work naturally. The propagation path determines WHERE the value lives:
- Entities in the path get their strategy's values on real rows
- Entities outside the path get zeros on real rows, values on reserve rows

Example: tuition (Student) allocated to Class, reserve for Professor. In a Student × Class × Professor table, allocated values appear only on Professor=RESERVE rows. Rolling up across Professor recovers the Class-level allocation. Rolling up across Class recovers the Student total.

### Elimination Direction Defaults

"Eliminate across the entity with fewer instances" is a good heuristic — minimizes the reserve row correction magnitude. This is a wizard/UX suggestion, not a schema constraint. Computable from `estimated_rows`.

### Shared Dimensions

No new relationship type needed. Shared dimensions are multi-hop propagation paths through a shared entity. Example: Student → Department → Professor, where Department connects two otherwise-unrelated entities. The shared entity enters the grain naturally when a metric propagates through it.

## Additional Findings

### 10. Reserve Means UNION ALL, Not CROSS JOIN

When two entities are all-reserve for each other, the codegen emits UNION ALL — separate row sets joined through any shared dimension. There is no cross product to generate or optimize away; reserve IS the sparse shape.

This has implications for estimation: when all metrics between two entities use reserve, their row counts should be **added**, not multiplied. The cross product never exists.

### 11. Shared Dimension Alignment

Two operationally unrelated entities (e.g., Facilities and Admissions) that share a time dimension (Month) can coexist in one table. Month is declared as an entity with relationships to both. The codegen joins each side through Month via UNION ALL, giving a combined table aligned on the shared dimension.

The shared entity provides explicit join semantics — no naming convention needed. The relationships declare HOW to join. Without them, column alignment would depend on matching column names (fragile).

### 12. Overlapping Chains Are Still Independent

Two propagation chains can share entities without requiring a cross product. The determining factor is whether any single metric spans both chains' unique entities — not whether the chains overlap.

Example: a university adds Advisors (Student ↔ Advisor, M-M). Salary propagates Professor → Class → Student (chain: {Professor, Class, Student}). Advising_budget propagates Advisor → Student → Class (chain: {Advisor, Student, Class}). These chains overlap on {Student, Class} but neither is a subset of the other.

The correct codegen is UNION ALL, not cross product:
- Group 1 (117 rows): Professor × Class × Student, Advisor=RESERVE. Salary has allocated values, advising_budget=0.
- Group 2 (180 rows): Advisor × Student × Class, Professor=RESERVE. Advising_budget has allocated values, salary=0.
- Total: 297 rows.

SUM-safety holds because each metric's values only appear in its own group. Rolling up to Student × Class works: GROUP BY collapses both groups, each metric's totals come from its group alone.

The cross product (234 rows) would also be SUM-safe, but it creates rows where both salary and advising_budget are 0 — wasted rows with no meaningful data. UNION ALL avoids this.

**Key principle:** chains are independent when no single metric spans both chains' unique entities. Shared intermediate entities don't change this — they appear in both UNION ALL groups serving different purposes in each.

### 13. Completely Unrelated Entities Are Valid

Two entities with no relationship at all can share a table with all-reserve metrics. This is a sparse union — each entity's rows appear independently. Mathematically sound (reserve never produces incorrect sums). Validation may warn but should not block.

**Note:** Finding 12 (overlapping chains) generalizes this: unrelated entities are the extreme case where chains share zero entities. The same UNION ALL logic applies.

## Current State

**Done:**
- types.ts updated to new schema (MetricPropagation, PropagationEdge replace MetricCluster, TraversalRule, ResolvedMetric)
- validate.ts rewritten: propagation path validation (connected paths, no cycles, strategy constraints)
- estimate.ts rewritten: deriveGrainEntities() computes grain from propagation paths; independent chains detected and summed (UNION ALL) instead of cross-producted
- yaml.ts updated for new schema
- 49 tests passing against new schema
- Reference manifests: university (multi-hop allocation, elimination, sum_over_sum), northwind (allocation by quantity, sum_over_sum for price), university-ops (shared dimension, independent chains)
- spec.md and system-design.md updated to match new schema
- All open questions resolved
- PR #2 open for review

**Not done:**
- P2 (codegen) blocked until schema stabilizes
