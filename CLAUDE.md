# bft-maker

## Overview
Big Flat Table maker. Takes a manifest describing entities, relationships, metrics, and coexistence strategies, and produces flat, SUM-safe reporting tables.

## Architecture
Three pieces, each depends only on the manifest types:
1. **Manifest** (src/manifest/) — schema types, validation, cost estimation
2. **Code Generator** (src/codegen/) — manifest → SQL (DuckDB primary, Spark SQL secondary)
3. **CLI** (src/cli/) — command-line interface for generating SQL from a manifest

There is no wizard UI. The "wizard" is an LLM conversation using docs/spec.md as context to guide a user through building a manifest.

## Stack
- TypeScript, minimal runtime dependencies (js-yaml for manifest parsing)
- DuckDB for local SQL execution
- Spark SQL as scale-out dialect
- Node built-in test runner

## Commands
- `npm run build` — compile TypeScript
- `npm test` — compile + run tests
- `npm run dev` — tsc watch mode

## Conventions
- Manifest types in src/manifest/types.ts are the source of truth
- YAML is for human readability and version control; TypeScript interfaces define the schema
- SQL templates use string interpolation, not Jinja or any templating language
- Each strategy (allocation, elimination, reserve, sum-over-sum) is an independent module
- Tests use snapshot approach: fixture manifest in → expected SQL out
- Generated SQL uses CTEs and window functions — standard analytical SQL

## Datasets
- data/northwind/ — small relational dataset (~2K junction rows) for unit-level testing

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
- For medium+ changes: create a plan document for review

**3. Get approval**
- Present your plan, highlight architectural decisions or trade-offs
- Wait for explicit go-ahead

**4. Implement**
- Keep changes focused
- Test appropriately throughout

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
