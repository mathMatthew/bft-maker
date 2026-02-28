# P4: PR #4 Review Follow-up

## Goal
Address issues surfaced during the PR #4 code review that weren't blocking merge.

## Status: Complete

## Current State
**All 24 items resolved.** 98 tests pass.

Key changes so far:
- Removed `checkSummarizationValidity` — all strategies survive summarization (elimination correction rows sum correctly through GROUP BY)
- Prohibited reserve as a propagation edge strategy (it's the implicit default)
- Fixed estimator placeholder counting for relationship metrics (use `estimated_links`)
- Added `q()` SQL identifier quoting throughout generator.ts
- Fixed shared path reference in YAML expansion, removed unused var
- **Removed `classifyBehavior` and `MetricBehavior` entirely** — strategies now compose as independent pipeline steps instead of being classified into monolithic behavior categories. Fixes the broken elimination + allocation combo case. See item #4 for details.
- **Fixed multi-hop elimination** — `elimCorrectionBranch` now generates one correction branch per elimination hop (not one per metric). Each hop anchors at home + all prior-hop entities. DuckDB-validated with new `professor_impact` test table (salary: Professor → Class elim → Student elim).
- Removed hardcoded directory depth from run script — uses `cd "$SCRIPT_DIR"` instead of `cd "$REPO_ROOT"` with `../../..`
- Unified `baseGrainBranch` into `groupBaseBranch` — eliminated logic duplication
- Added `valid-identifier` validation rule — rejects names with spaces, hyphens, or other non-identifier characters

## Issues

### Correctness

1. ~~**Validator misses intermediate-hop summarization check**~~ → **RESOLVED: removed `checkSummarizationValidity` entirely.** The premise was wrong: all propagation strategies survive summarization. Elimination's correction rows sum correctly through GROUP BY + SUM. The "compute at full grain, then summarize" model works for every strategy. Additionally, reserve was prohibited as a propagation edge strategy (it's the implicit default when an entity is omitted from the path). Updated spec.md accordingly.

2. ~~**Estimator placeholder count wrong for relationship metrics with reserve**~~ → **RESOLVED.** Refactored placeholder counting to track by home (entity or relationship name) instead of individual entities. Relationship metrics now use `estimated_links`; entity metrics use `entity.estimated_rows`. Also removed dead `reserve` strategy check from propagation edges (reserve in paths is now prohibited by the validator).

3. ~~**No SQL identifier quoting**~~ → **RESOLVED.** Added `q()` helper that wraps all SQL identifiers in DuckDB double-quotes. Applied to all table names, column names, metric names, derived names, and intermediate table names throughout `generator.ts`. DuckDB integration tests confirm the quoted SQL is valid.

4. ~~**`mixed` behavior classification is too coarse**~~ → **RESOLVED: removed behavior classification entirely.** The `classifyBehavior` function and `MetricBehavior` type were deleted. Each propagation strategy is now handled independently:
   - Base grain rows check `reserveDimensions.length` and `metric.nature` directly instead of a behavior label
   - `propagationDataBranch` (new): SELECT DISTINCT from weighted table for metrics with reserve dims + propagation — handles any strategy combo
   - `elimCorrectionBranch` (new): uses COUNT(DISTINCT target_id) from base table — works regardless of reserve dims
   - `collectWeights` now generates weights for ANY metric with allocation dims (previously skipped mixed/elim metrics) and partitions by ALL prior hops regardless of strategy
   - Multi-hop elimination now generates per-hop correction branches; DuckDB-validated with `professor_impact` test (Professor → Class elim → Student elim). elim+alloc and alloc+elim combos verified mathematically but not yet integration-tested.

5. ~~**Shared path reference in `expandPropagations`**~~ → **RESOLVED.** Each expanded propagation now gets a shallow copy of each path edge via `prop.path.map(e => ({...e}))`.

### Code Quality

6. ~~**Inline `import(...)` type in planner signature**~~ → **RESOLVED.** Changed to use the already-imported `Strategy` type from manifest/types.

7. ~~**Unused variable `elimEntityCol`**~~ → **RESOLVED.** Removed.

8. ~~**Run script hardcodes directory depth**~~ → **RESOLVED.** Removed `REPO_ROOT` assumption; run script now uses `cd "$SCRIPT_DIR"` so it works from any output location.

9. ~~**Missing type re-exports from `codegen/index.ts`**~~ → **RESOLVED.** Added `DimensionStrategy`, `GrainGroup`, `JoinLink` to the re-exports.

10. ~~**`baseGrainBranch` vs `groupBaseBranch` logic duplication**~~ → **RESOLVED.** Deleted `baseGrainBranch`; its call site now constructs a full-grain `GrainGroup` and calls `groupBaseBranch`.

11. ~~**`buildAliasMap` not used consistently across branch functions**~~ → **RESOLVED: N/A.** `reserveBranch` and `elimCorrectionBranch` each SELECT from a single table (raw entity table or materialized `_base` table) with no joins — column references are unqualified, so alias collision is not possible. `buildAliasMap` is only needed in `baseJoinSQL` where multiple tables are joined.

12. ~~**`classifyBehavior` naming**~~ → **RESOLVED: function deleted.** No longer applicable.

### Missing Tests

13. ~~**No planner unit test for class_summary**~~ → **RESOLVED.** Added test for summarization, grain grouping, and `needsSummarization=true`.

14. ~~**No planner test for `enrollment_grade`**~~ → **RESOLVED.** Added test verifying junction metric home grain, kind, and natural-grain handling.

15. ~~**No validation test for `reserve` at summarization boundary**~~ → **RESOLVED: summarization check removed; reserve-in-path rejection test added.**

16. ~~**No validation test for `sum_over_sum` accepted at summarization boundary**~~ → **RESOLVED: summarization check removed; no boundary check exists.**

17. ~~**No estimator test for relationship metric with reserve/elimination placeholders**~~ → **RESOLVED.** Added tests for reserve and elimination placeholder counting using `estimated_links`.

18. ~~**No YAML round-trip test for relationship metrics**~~ → **RESOLVED.** Added test verifying relationship metrics survive serialize/parse round-trip.

19. ~~**No reference SQL validation for `enrollment_grade` in student_experience**~~ → **RESOLVED.** Added DuckDB validation for enrollment_grade SUM in student_experience. (satisfaction_score weighted average validation not added — deferred.)

20. ~~**Temp file leak in `runSQL` test helper**~~ → **RESOLVED.** Added try/finally to all three `runSQL` functions.

### Future

24. ~~**Validator should reject non-identifier characters in names**~~ → **RESOLVED.** Added `valid-identifier` rule that checks all entity, relationship, metric, and table names match `/^[A-Za-z_][A-Za-z0-9_]*$/`. Five tests added.

### Doc Inconsistencies

21. ~~**spec.md** claims reserve-only tables skip the base join~~ → **RESOLVED.** Added notes that the current generator does not implement this optimization.

22. ~~**system-design.md** claims junction metric SUM test for student_experience~~ → **RESOLVED.** Corrected to note it's class_summary only.

23. ~~**P3_GRAIN_AWARE.md** stale test count~~ → **RESOLVED.** File already deleted after P3 merge.
