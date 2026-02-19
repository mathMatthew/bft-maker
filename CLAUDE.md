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
- data/movielens/ — MovieLens dataset (100K+ ratings) for integration testing; downloaded via script, not checked into git

## Key Concepts
- **BFT**: Big Flat Table — a single flat table where every numeric column is safe to SUM (or explicitly flagged as requiring Sum/Sum weighted average)
- **Strategy**: What a metric means on rows that aren't its own entity — Reserve, Elimination, Allocation, or Sum/Sum
- **Manifest**: Declarative spec that fully describes entities, relationships, metrics, traversal rules, and table topology
- **Grain**: What a row represents in the output table (e.g., Student × Class × Professor)
