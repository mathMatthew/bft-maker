# Project 2: Code Generator

## Goal
Implement the code generator that takes a validated manifest and produces executable SQL files plus validation queries. DuckDB dialect first, Spark SQL second.

## Scope
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
- Snapshot tests: fixture manifests → expected SQL output

## Dependencies
- Requires Project 3 (manifest types + validation)

## Success Criteria
- Feed the university fixture manifest → get numbered SQL files
- Execute those SQL files against DuckDB with synthetic data
- All validation queries return zero rows
- SUM of allocated metrics equals SUM of originals
- Each strategy template produces correct, executable SQL

## Status
Pending
