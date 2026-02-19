# Project 3: Manifest Schema + Validation

## Goal
Implement the manifest type system and validator. This is the foundation — everything else depends on it.

## Scope
- TypeScript interfaces in src/manifest/types.ts matching the schema in system-design.md
- YAML parsing (read a manifest.yaml, produce a Manifest object)
- Comprehensive validation in src/manifest/validate.ts
- Row count estimator in src/manifest/estimate.ts
- Unit tests for validation (invalid manifests) and estimation (known cardinalities)

## Validation Rules
- All entity names referenced in relationships must exist
- All metric names referenced in clusters must exist on some entity
- All relationship names referenced in traversal rules must exist
- Every metric in every cluster must have a traversal rule (or be direct/native)
- Grain entities must form a connected graph through declared relationships (or be explicitly unrelated)
- Non-additive metrics must use sum_over_sum strategy, not allocation/elimination
- Estimated rows/links must be positive integers
- No duplicate entity names, metric names, relationship names, or table names

## Success Criteria
- Can round-trip: YAML → Manifest object → YAML
- Validator catches every inconsistency listed above with clear error messages
- Estimator produces correct row counts for the university example from the spec
- All unit tests pass

## Status
Pending
