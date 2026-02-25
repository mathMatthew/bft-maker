# P4: PR #4 Review Follow-up

## Goal
Address issues surfaced during the PR #4 code review that weren't blocking merge.

## Status: Pending

## Issues

### Correctness

1. **Validator misses intermediate-hop summarization check**
   `validate.ts` `checkSummarizationValidity` only checks when `homeNotInGrain.length > 0`. Misses the case where a metric's home entity IS in the BFT grain but its propagation path passes through an intermediate entity needing summarization with an unsupported strategy (e.g., metric on A, path A->B->C, grain={A,C}, A->B uses elimination — validator won't catch it).

2. **Estimator placeholder count wrong for relationship metrics with reserve**
   `estimate.ts` ~lines 171-189: For a relationship metric (home grain={Student, Class}) with a reserve dimension, placeholder rows are estimated as `student_rows + class_rows`. Should use `estimated_links` for relationship metrics. No current manifest triggers this.

3. **No SQL identifier quoting**
   Throughout `generator.ts`, entity/metric/table/column names are interpolated into SQL without quoting. SQL reserved words (e.g., entity named `Order`, metric named `select`) produce invalid SQL. DuckDB supports `"quoted_identifiers"`.

4. **`mixedElimCorrectionBranch` only handles first elimination dimension**
   `generator.ts` ~line 871 — only `elimDims[0]` is used. If a metric has elimination toward multiple dimensions, only the first is corrected. The validator currently prevents this, but the assumption isn't documented or enforced in the generator.

5. **Shared path reference in `expandPropagations`**
   `yaml.ts` ~line 18: When `metric: [a, b, c]` is expanded, all propagations share the same `path` array object. Nothing currently mutates paths post-parse, but it's a mutation-aliasing landmine. Fix: `path: prop.path.map(e => ({...e}))`.

### Code Quality

6. **Inline `import(...)` type in planner signature**
   `planner.ts` ~line 89 uses `import("../manifest/types.js").Strategy` instead of the already-available `Strategy` type.

7. **Unused variable `elimEntityCol`**
   `generator.ts` ~line 884: computed but never used.

8. **Run script hardcodes directory depth**
   `generator.ts` ~line 1003: `REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"` assumes output is exactly 3 levels below repo root.

9. **Missing type re-exports from `codegen/index.ts`**
   `GrainGroup`, `JoinLink`, `DimensionStrategy`, `MetricBehavior` are used in exported `TablePlan`/`MetricPlan` types but aren't re-exported.

10. **`baseGrainBranch` vs `groupBaseBranch` logic duplication**
    These two functions duplicate significant logic and could be unified.

11. **`buildAliasMap` not used consistently across branch functions**
    `reserveBranch`, `eliminationCorrectionBranch`, `mixedElimCorrectionBranch` still use hardcoded single-char aliases instead of `buildAliasMap`.

12. **`classifyBehavior` naming**
    Returns `"fully_allocated"` for zero-dimension metrics (no propagation needed). Functionally correct but semantically misleading — `"native"` or `"direct"` would be clearer.

### Missing Tests

13. **No planner unit test for class_summary** — summarization, grain grouping, and `needsSummarization=true` only covered by DuckDB integration tests.

14. **No planner test for `enrollment_grade`** (junction metric) in student_experience or department_financial.

15. **No validation test for `reserve` at summarization boundary** — only `elimination` rejection tested.

16. **No validation test for `sum_over_sum` accepted at summarization boundary**.

17. **No estimator test for relationship metric with reserve/elimination placeholders**.

18. **No YAML round-trip test for relationship metrics**.

19. **No reference SQL validation for `enrollment_grade` in student_experience** or for `satisfaction_score` weighted average.

20. **Temp file leak in `runSQL` test helper** — if `execSync` throws, no try/finally cleanup.

### Doc Inconsistencies

21. **spec.md** claims reserve-only tables skip the base join; the generator doesn't implement this. Flag as future optimization or remove the claim.

22. **system-design.md** claims integration tests assert junction metric SUM for student_experience, but no such check exists for that table.

23. **P3_GRAIN_AWARE.md** states "all existing 71 tests pass" but suite now has 84.
