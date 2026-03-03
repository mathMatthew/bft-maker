# P5: TUI for Manifest Building

## Goal
A terminal UI that guides users through building a BFT manifest — from data model discovery through strategy definition to BFT table composition.

## Prerequisite
User prepares a DuckDB database (`.duckdb` file) containing their data as tables or views. DuckDB can import from anything (CSV, Parquet, Postgres, MySQL, SQLite, ODBC via nanodbc extension), so this is a universal entry point.

## Workflow

### Step 1: Data Model Discovery
TUI opens the `.duckdb` file and introspects via `information_schema` + sample queries:
- Auto-detects PKs (snake_case `_id` and camelCase `ID` conventions), FKs, junction tables, candidate metrics
- Loads 5 sample rows per table for preview
- User reviews/edits: reclassify tables, edit column roles, preview data
- Metric classification: additive/non-additive with sample values shown, or "Not a metric — remove"

### Step 2: Strategy Matrix
Custom grid on alternate screen: metrics on rows, entities on columns. Navigate with arrows/hjkl, cycle with space/enter, q to finish.

### Step 3: Weight Definition
For each allocation/sum-over-sum cell, user provides the weight column name.

### Step 4: BFT Table Composition
User defines BFT tables by selecting grain entities and metrics.

### Hub Menu
After step 1, a non-linear hub menu lets the user jump to any section, see completion status, and generate when ready. Progress is saved after each step; drafts persist across sessions.

## Stack

**@clack/prompts + custom strategy matrix grid**, vanilla TypeScript.

- **@clack/prompts** for form steps (select, multiselect, text). `q` mapped to cancel globally via `updateSettings`. Text prompts temporarily disable the alias.
- **Custom ANSI grid** for the strategy matrix. Alternate screen buffer for clean rendering.
- **chalk** for colors, **ansi-escapes** for cursor control, **duckdb** for introspection.

### Module structure

```
src/wizard/
├── index.ts              # Hub menu, wizard runner
├── state.ts              # Wizard state + pure transition functions
├── introspect.ts         # DuckDB introspection: tables, FKs, metrics, sample rows
├── draft.ts              # Save/load draft state for resume
├── steps/
│   ├── data-model.ts     # Step 1: discovery + table preview + metric classification
│   ├── strategy-matrix.ts # Step 2: grid launcher
│   ├── weights.ts        # Step 3: weight prompts
│   └── tables.ts         # Step 4: table composition
└── grid/
    ├── layout.ts         # Pure layout math: column widths, scroll, viewport
    ├── renderer.ts       # ANSI grid drawing
    └── input.ts          # Raw mode keypress handling
```

## Design Decisions
- **TUI, not web UI** — fits the developer tool nature of bft-maker
- **Directed relationship graph** — direction defined in data model, matrix shows reachability
- **Sample data, not full queries** — rows loaded on demand for preview (user-configurable count). Row counts from actual data; no surprise queries against large tables.
- **Hub menu over linear wizard** — after the data model step, user can jump to any section. Progress saved as drafts.
- **`q` to quit everywhere** — clack alias maps `q` → cancel in select/multiselect; grid uses `q` natively

## Known Limitations
- **No self-joins** — a table cannot reference itself (e.g., `employees.ReportsTo → employees.employee_id`). Self-referential relationships create recursive propagation paths that the current manifest/codegen doesn't support. The UI shows these as disabled with "self-join not supported" hint. Supporting hierarchical propagation requires changes to the manifest schema, planner, and SQL codegen.

## Open Questions
- How to visualize the directed relationship graph in a terminal
- Multi-hop paths in the matrix: user defines each hop vs TUI infers from graph

## Status
Implementation in progress on `feat/p5-tui-wizard`. Core wizard functional, manual testing with Northwind dataset ongoing.

### Done
- Core wizard: introspection → data model review → strategy matrix → weights → table composition → manifest YAML
- Auto-detection of PKs, FKs, junctions, metrics — handles both snake_case and camelCase conventions
- Junction table metrics detected and placed on relationships
- Strategy matrix + table preview on alternate screen buffers
- `q` to quit, SIGINT handler, "Not a metric" option, sample values in prompts
- Save/load draft with hub menu for non-linear navigation
- Session 2 committed: hub menu, draft persistence, data model preview
- **Preview screen** (session 3):
  - Column classifications shown: key (yellow), additive (green), non-additive (magenta), metric? (green, unclassified), FK (cyan), attr (dim)
  - Inline keybindings: `r` change row count (any number), `d` toggle first-rows/distinct-values, `e` edit table, `q`/esc back
  - Row count and mode persist across previews in session
  - Distinct values mode: uncorrelated per-column `SELECT DISTINCT` values
- **Inline metric classification**: additive/non-additive asked when setting a column as metric in edit (no separate pass needed; end-of-step pass only asks about remaining unclassified)
- **Draft saves detected model**: introspection results saved so resume skips re-introspecting; table selection re-shown on resume so nothing is locked in
- **Audit: everything reachable on resume** — table inclusion, classification, column roles, metric nature, strategy matrix, weights, tables. Excluded tables kept in model.tables for re-inclusion.
- 187 tests passing

### Remaining
- [ ] Commit session 3 improvements (preview, inline metrics, draft model save)
- [ ] Manual testing with Northwind (wide matrix)
- [ ] PR
