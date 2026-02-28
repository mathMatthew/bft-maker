# Project 1: Datasets, Fixtures, and CLI

## Goal
Build test fixtures from real datasets, write integration tests, and create the CLI entry point.

## Status: Complete

## What was done

### CLI
- `src/cli/index.ts`: `generate` and `validate` commands, no framework deps
- `npx bft-maker generate --manifest <path> [--output <dir>]`
- `npx bft-maker validate --manifest <path>`
- Clean error messages for missing files, validation failures

### Schema extensions
- Added `source_table`, `id_column`, `label_column` to Entity type
- Added `source_table`, `columns` to Relationship type
- Added `source_column` to MetricDef type
- Added `score` to MetricDef type union
- Planner uses overrides when provided, falls back to naming conventions

### Fixtures with DuckDB integration tests
- **University** (3 manifests): allocation, elimination, sum_over_sum, summarization, junction metrics, multi-hop, strategy composition
- **Northwind** (real data): allocation + sum_over_sum + reserve across 830 orders × 77 products via 2155 order_details. Uses source_table/id_column/source_column overrides for camelCase CSV columns.
- **Single-entity**: degenerate case — one entity, one metric, no relationships
- **University-ops**: shared dimension pattern — Building×Month UNION ALL Program×Month, unrelated entities via shared Month dimension

### MovieLens manifest
- `data/movielens/manifest.yaml`: validates correctly, exercises relationship metrics at scale
- Excluded from DuckDB integration: no standalone user entity table in dataset

### Bug fixes
- Fixed `package.json` bin path (`dist/src/cli/` not `dist/cli/`)
- Fixed sum_over_sum weight validation for propagated non-additive metrics (was incorrectly checking per-home-entity weights)
- Generator now uses `sourceColumn` when reading from source tables, aliasing to metric name in intermediate tables

## Test results
118 tests pass (up from 98). Integration tests cover 7 fixtures × 2 checks each (validations pass + row count > 0) plus the existing unit and DuckDB tests.
