# Backlog

No open items. Items below have been resolved.

---

## Resolved

### 1. Correction row structure and naming (resolved)

**Problem:** "Reserve row" was used for three different things: the reserve strategy, the correction mechanism, and the label on the report. Confusing because elimination metrics also need correction rows.

**Resolution:**

| Concept | Name |
|---|---|
| Strategy: don't distribute | **reserve** |
| Strategy: repeat full value | **elimination** |
| Row correcting reserve metrics | **reserve row** |
| Row correcting elimination metrics | **elimination row** |
| Label for reserve rows on report | configurable, default `<Unallocated>` |
| Label for elimination rows on report | configurable, default `<Unallocated>` |

"Correction row" is the umbrella term for both. One correction row per entity VALUE (not per entity), so correction row count = `entity.estimated_rows` for each entity needing corrections.

Both labels default to the same value so they land on the same row in practice. Configurable via `correction_labels` in the manifest.

### 2. Grain derivation from propagation paths (resolved)

**Problem:** `deriveGrainEntities` unioned all entities from all propagation paths, causing grain surprises. Adding `tuition_paid` (path: Student → Class → Professor) to a Student × Class table silently pulled Professor into the grain.

**Resolution:** Grain is declared explicitly on the table via an `entities` field. The table declares both which entities (grain) and which metrics to include — two independent decisions. Propagation paths describe what a metric MEANS when it encounters foreign entities; they don't determine the grain. Only hops whose target entity is in the declared grain are active.

```yaml
bft_tables:
  - name: student_experience
    entities: [Student, Class]
    metrics: [tuition_paid, satisfaction_score, class_budget]
```

The math is always correct regardless of what entities/metrics you pick. The wizard can warn about useless configurations (e.g., "tuition is reserve for Class, so you'll see zeros on every Class row"), but validation doesn't block them.

This resolves SCHEMA_DESIGN.md open question #14.
