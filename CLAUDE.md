# bft-maker

## Overview
Big Flat Table maker. Takes a manifest describing entities, relationships, metrics, and coexistence strategies, and produces flat, SUM-safe reporting tables.

## Architecture
Four pieces, each depends only on the manifest types:
1. **Manifest** (src/manifest/) — schema types, validation, cost estimation
2. **Code Generator** (src/codegen/) — manifest → SQL (DuckDB primary, Spark SQL secondary)
3. **CLI** (src/cli/) — command-line interface: `generate`, `validate`, `introspect`, `wizard`
4. **Wizard** (src/wizard/) — TUI for building and editing manifests interactively; introspection logic lives here too

## Stack
- TypeScript, minimal runtime dependencies (js-yaml for manifest parsing)
- DuckDB for local SQL execution
- Spark SQL as scale-out dialect
- Node built-in test runner

## Commands
- `npm run build` — compile TypeScript
- `npm test` — compile + run tests
- `npm run dev` — tsc watch mode
- `bft-maker introspect --db <path>` — print detected schema (entities, junctions, metrics, FKs)
- `bft-maker wizard --db <path> [--manifest <path>] [--output <path>]` — interactive manifest builder/editor
- `bft-maker validate --manifest <path>` — validate a manifest and report errors
- `bft-maker generate --manifest <path> [--output <dir>]` — generate SQL from a manifest

## Manifest-Building Workflow

When helping a user build a manifest for a DuckDB file:

1. **Read the spec** — `docs/spec.md` is the authoritative reference for manifest format, strategies, and concepts. Read it before starting.
2. **Introspect the DB** — run `bft-maker introspect --db <path>` and read the output. This tells you entities, junction tables, detected metrics, and FK relationships.
3. **Converse and build** — ask the user what they need to see together on a report and what the numbers should mean. Use the strategy guide in spec.md to pick Reserve / Elimination / Allocation / Sum-over-Sum for each metric × entity combination.
4. **Write the manifest YAML** — use `data/university/manifest.yaml` as a reference for format and structure.
5. **Validate** — run `bft-maker validate --manifest <path>`. Fix any errors and repeat.
6. **Hand off to the wizard** — once the manifest validates, the user can run `bft-maker wizard --db <path> --manifest <path>` to review and edit it interactively.

## Conventions
- Manifest types in src/manifest/types.ts are the source of truth
- YAML is for human readability and version control; TypeScript interfaces define the schema
- SQL templates use string interpolation, not Jinja or any templating language
- Each strategy (allocation, elimination, reserve, sum-over-sum) is an independent module
- Tests use snapshot approach: fixture manifest in → expected SQL out
- Generated SQL uses CTEs and window functions — standard analytical SQL

## Datasets
- `data/northwind/` — classic order-management schema, used for unit-level testing
- `data/university/` — Student × Class × Professor schema, primary fixture for strategy tests
- `data/movielens/` — User × Movie ratings schema
- `data/semi-additive/` — semi-additive / stock metric examples
- `data/single-entity/` — single-entity manifest examples
- `data/university-ops/` — university schema variant with operational metrics

## Key Concepts
- **BFT**: Big Flat Table — a single flat table where every numeric column is safe to SUM (or explicitly flagged as requiring Sum/Sum weighted average)
- **Strategy**: What a metric means on rows that aren't its own entity — Reserve, Elimination, Allocation, or Sum/Sum
- **Manifest**: Declarative spec that fully describes entities, relationships, metrics, traversal rules, and table topology
- **Grain**: What a row represents in the output table (e.g., Student × Class × Professor)


<!-- TEAM_CONVENTIONS_START -->
# Team Conventions

## How We Work

### Core Principles

- **Approval before changes** - Summarize what you'll change, explain the approach, wait for explicit approval
- **Understand before acting** - Read the relevant code, understand context within the larger system, don't guess
- **Evidence-based decisions** - Base decisions on code analysis, logs, and observed behavior
- **Keep docs current** - Update project docs after significant progress (what was done, how to verify, next steps)

### Problem-Solving Approach

**1. Understand the problem**
- Investigate how the code works and interacts with the larger system
- For bugs: identify root cause, examine data flows and edge cases, confirm hypothesis before proceeding
- For enhancements: restate goals, identify integration points, consider architecture fit
- Except for simple items, explore before proposing. Use parallel agents to investigate: what existing code can be reused, and what edge cases or gotchas exist in the affected area. Summarize findings before proposing an approach.

**2. Plan the solution**
- For bugs: explain how the fix addresses root cause directly
- For enhancements: document what changes where, consider trade-offs
- For medium+ changes: write an implementation plan into the project doc:
  - Specific files with specific changes (use `file:line` references), not prose
  - For complex tasks, use parallel agents to explore different approaches (simplicity vs. performance, root cause vs. workaround) before converging
  - Re-read critical files right before planning — don't rely on what you read 20 minutes ago
  - One verification step (test command, manual check, etc.)
  - Keep it tight — no context/background sections, no restating the problem

**3. Get approval**
- Present your plan, highlight architectural decisions or trade-offs
- Wait for explicit go-ahead

**4. Implement**
- Keep changes focused
- Test appropriately throughout
- For medium+ changes: suggest a fresh session for implementation. Before ending, confirm: "I've updated the project doc with the implementation plan — start a new session with `/p 8`." Always verify the doc is saved before saying this. A clean context with just the project doc and plan gives maximum runway.

## Code Standards

- Before proposing abstractions or new patterns, prefer the simplest approach first
- When fixing bugs, investigate the actual root cause before dismissing symptoms as known issues
- When duplicate code is found, consolidate to a single source before fixing
- Utility/translation functions must be pure — no hidden side effects or mutations

## Git

- **No co-author lines** - Never add `Co-Authored-By: Claude` or similar to commit messages
- **Always `git fetch` before checking remote state** - Never rely on stale local refs
- **Branch before working** - Create a feature branch before starting project work. Don't commit directly to main.
- **PR on completion** - Create a pull request when a project completes

## Project Management

Use `/p <N>` to load a project context. Work order: highest to lowest.

When a project is done:
1. Get user confirmation
2. Create a pull request for the project's work
3. Clean up project docs
4. Move to next project
<!-- TEAM_CONVENTIONS_END -->
