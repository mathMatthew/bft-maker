# P5: TUI for Manifest Building

## Goal
A terminal UI that guides users through building a BFT manifest — from data model discovery through strategy definition to BFT table composition.

## Prerequisite
User prepares a DuckDB database (`.duckdb` file) containing their data as tables or views. DuckDB can import from anything (CSV, Parquet, Postgres, MySQL, SQLite, ODBC via nanodbc extension), so this is a universal entry point. No queries are run against user data at runtime — all metadata comes from `information_schema` and schema constraints.

## Workflow

### Step 1: Data Model Discovery

#### 1a. Pick Tables & Classify Columns
TUI opens the `.duckdb` file and introspects via `information_schema`:
- Lists tables → user picks which are entities (vs junction tables vs ignored)
- For each entity, shows columns with types → user classifies as:
  - **ID** (primary key — can be composite, e.g. `store_id, month`)
  - **Metric** (numeric columns that will be summed/aggregated)
  - **Reference data** (labels, names — along for the ride, no independent value)
- Row counts and estimated_links are provided by the user (not derived from data queries)
- Auto-detection aids: numeric columns default to metric candidates, text to reference

#### 1b. Define Directed Relationships
User defines directed edges in a relationship graph. Each edge has:
- **From entity** + key columns
- **To entity** + key columns
- **Junction table** (for M-M relationships)
- **Direction** — defaults to one-way (left → right as entered), user can toggle to bidirectional

Composite keys are supported (e.g. join on `store_id + month`).

**Cardinality and direction defaults:**
- For M-1 relationships, direction is auto-set based on schema constraints: many → one (the side with a unique/primary key constraint is the "one" side). Derived from `information_schema` metadata, not data queries.
- For M-M relationships, defaults to the order the user specified (left → right). User can flip or make bidirectional.

**Cycle detection:**
- Runs on every edge add/toggle (cheap DFS on directed graph)
- If adding an edge or toggling to bidirectional would create a cycle, warn immediately and ask the user to pick a direction to break it
- Cycles are blocked — they mean infinite propagation paths

The relationship graph gates the strategy matrix: if there's no directed path from a metric's home entity to another entity, that cell is N/A (grayed out). User can go back and add/change relationships to unlock cells.

Auto-detection where possible: foreign key constraints, shared column names across tables. User confirms/edits.

### Step 2: Strategy Matrix
A grid view: metrics on rows (grouped by home entity), entities on columns.
- "H" marks the home entity for each metric (auto-filled from step 1)
- User fills in "E" (elimination) or "A" (allocation) for reachable entities
- Unreachable entities (no directed path from home) are grayed out / N/A
- Blank = reserve (the default)
- This matrix is a transient workspace — a tool for defining propagation rules, not permanent state

### Step 3: Weight Definition
For each "A" (allocation) cell in the matrix, user defines the weight. This step only appears for metrics that have allocation strategies.

### Step 4: BFT Table Composition
User composes BFT tables by selecting entities and metrics. Reference data comes along for the ride — it helps interpret metrics but has no value on its own. No metric, no row, no need for reference data.

## Design Decisions
- **TUI, not web UI** — fits the developer tool nature of bft-maker
- **Directed relationship graph** — direction is defined in the data model (step 1b), not in the strategy matrix. The matrix just shows what's reachable. Same approach as Power BI.
- **No data queries** — all metadata from `information_schema` and schema constraints. Row counts and estimated_links are user-provided. No surprise queries against large tables.
- **Same metric, different paths** — a metric can be propagated to the same entity via different paths or with different allocation schemes, producing named variants (e.g. `salary_by_headcount` vs `salary_by_fte`)
- **Default naming with easy overrides** — auto-generate names, let user tweak
- **Composite keys** — relationships can join on multiple columns (e.g. `store_id + month`)
- **Cycle-free graph** — cycles detected and blocked at edge definition time

## Open Questions
- TUI framework choice (Ink/React, blessed, raw ANSI, something else?)
- How to handle wide matrices (many entities) in terminal width constraints
- Exact interaction model for the matrix (cursor navigation? vim keys? tab between cells?)
- Does the output go directly to a manifest YAML, or is there an intermediate format?
- How to visualize the directed relationship graph in a terminal (ASCII arrows? list view?)
- Multi-hop paths in the matrix: does the user define each hop separately, or does the TUI infer paths from the graph?

## Status
Design — workflow, data model, and key constraints agreed. Implementation not started.
