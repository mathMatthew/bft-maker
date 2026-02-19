# Project 1: Datasets, Fixtures, and CLI

## Goal
Build test fixtures from real datasets, write integration tests, and create the CLI entry point.

## Scope

### Datasets
- Northwind (small): download CSVs, create a manifest that exercises Orders↔Products and Employees↔Territories M-M relationships
- MovieLens (larger): download ml-latest-small (100K ratings), create a manifest that exercises Users↔Movies via ratings and tags

### Fixtures
- University fixture (from spec examples): synthetic data + manifest
- Northwind fixture: real data + manifest
- MovieLens fixture: real data + manifest
- Simple fixture: two unrelated entities, shared dimensions only
- Single entity fixture: degenerate case, no foreign metrics

### CLI
- src/cli/index.ts: parse args, read YAML manifest, validate, generate SQL
- Commands: `generate` and `validate`

### Integration Tests
- End-to-end: manifest → SQL → execute in DuckDB → validation passes
- Run against each fixture

## Dependencies
- Requires Project 3 (manifest types) and Project 2 (code generator)

## Success Criteria
- Download scripts work for both datasets
- Every fixture has a valid manifest and synthetic/real source data
- Integration tests pass for all fixtures
- CLI works: `npx bft-maker generate --manifest fixture.yaml --output ./out/`

## Status
Pending
