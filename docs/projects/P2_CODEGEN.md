# Project 2: Code Generator

## Goal
Implement the code generator that takes a validated manifest and produces executable SQL files plus validation queries. DuckDB dialect first, Spark SQL second.

## Plan

### Phase 1: Hand-write reference SQL
Write the actual DuckDB SQL for the university manifest by hand. This manifest exercises all four strategies (allocation, elimination, reserve, sum_over_sum), multi-hop allocation, and placeholder rows. Create synthetic data, run the SQL, and verify results with validation queries. The hand-written SQL becomes the design spec for the generator — you can't generate SQL until you know what correct SQL looks like.

Deliverables:
- Synthetic university data (CSVs or DuckDB INSERT statements)
- Hand-written SQL that produces both BFT tables (department_financial, student_experience)
- Validation queries that pass (SUM checks, row counts, placeholder label checks)
- Document any SQL patterns or decisions that surface during this work

### Phase 2: Build the generator
Mechanically reproduce the hand-written SQL from Phase 1. The generator reads a manifest and emits the same SQL patterns.

- Build planner (src/codegen/planner.ts): manifest → ordered build steps
- SQL templates for each strategy:
  - allocation.ts — window function with weight distribution
  - elimination.ts — full value on foreign rows + negating offset on placeholder rows
  - reserve.ts — value on placeholder rows only, zero on foreign rows
  - sum-over-sum.ts — raw value + companion weight column
  - join.ts — base grain join and final assembly
  - validation.ts — assertion queries (zero rows = pass)
- DuckDB dialect (src/codegen/dialects/duckdb.ts)
- File emitter (src/codegen/emit.ts): writes numbered .sql files + run.sh
- Snapshot tests: generator output matches the hand-written SQL from Phase 1

## Dependencies
- Requires Project 3 (manifest types + validation) — done

## Success Criteria
- Feed the university fixture manifest → get numbered SQL files
- Execute those SQL files against DuckDB with synthetic data
- All validation queries return zero rows
- SUM of allocated metrics equals SUM of originals
- Each strategy template produces correct, executable SQL

## Phase 1 Findings

### SQL Patterns

**Allocation** (equal-share):
```sql
metric * 1.0 / COUNT(DISTINCT target_entity_id) OVER (PARTITION BY home_entity_id)
```
No placeholder rows. SUM always correct.

**Multi-hop allocation** — cascade the shares. In a (student, class, professor) grain:
```sql
metric * 1.0
  / COUNT(DISTINCT class_id) OVER (PARTITION BY student_id)      -- hop 1 share
  / COUNT(*) OVER (PARTITION BY student_id, class_id)            -- hop 2 share
```
Each hop divides by the fan-out at that level. `COUNT(DISTINCT ...)` needed at hop 1 because the base grain fans out at hop 2.

**Elimination**:
```sql
-- Regular rows: full value
SELECT ..., class_budget * 1.0 AS class_budget FROM base
UNION ALL
-- Correction rows: value * (1 - N) where N = foreign rows per home entity value
SELECT ..., '<Unallocated>' AS student_name, class_budget * (1 - COUNT(*)) AS class_budget
FROM base GROUP BY class_id, class_name, class_budget
```

**Reserve**: Simplest pattern. Value on placeholder rows only (all foreign entity columns = `<Unallocated>`), zero on all other rows. One UNION ALL branch per reserved metric.

**Sum/Sum**: Raw value preserved + companion weight column. Weight = `1.0 / COUNT(*) OVER (PARTITION BY home_entity_id)`. Weights sum to 1.0 per entity.

### Multi-Dimension Interaction

When a metric is **elimination for one dimension and reserve for another** (e.g., class_budget: elimination→Student, reserve for Professor), the elimination plays out on the reserve's placeholder rows. The metric is zero on all rows where the reserve dimension has a real value. This produces three row types:

1. Base grain rows → metric = 0
2. Reserve placeholder rows (Prof=`<Unallocated>`) → metric = full value (elimination data)
3. Double-placeholder rows (Student+Prof=`<Unallocated>`) → metric = elimination correction

### Row Count Formula

Final table rows = base grain + sum of placeholder rows across all metrics:
- **Allocation**: 0 placeholder rows
- **Sum/Sum**: 0 placeholder rows
- **Elimination** (per non-propagated dimension): one row per (enrollment × reserved dimensions) + one correction row per home entity value
- **Reserve** (per reserved dimension set): one row per home entity value

University department_financial: 113 base + 90 elim data + 10 elim correction + 5 reserve = 218.
University student_experience: 90 base + 10 elim correction = 100.

### Files

Reference SQL lives in `data/university/sql/`:
- `00_load_data.sql` — CSV loading
- `student_experience.sql` — 2-entity BFT (6 validation checks)
- `department_financial.sql` — 3-entity BFT (9 validation checks)
- `run.sh` — runs all SQL, reports pass/fail

All 15 validations pass.

## Status
Phase 1 complete. Next: Phase 2 (build the generator).
