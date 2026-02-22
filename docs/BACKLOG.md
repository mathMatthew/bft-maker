# Backlog

No open items. Items below have been resolved.

---

## Resolved

### 1. Placeholder labels and row structure (resolved)

**Problem:** "Reserve row" was used for three different things: the strategy, a row mechanism, and the label on the report. Confusing because the concept is really about what value goes in an entity column, not about special rows.

**Resolution:** The concept is **placeholder labels** — the value shown in an entity column when a metric on that row isn't about a specific entity (default `<Unallocated>`). Reserve and elimination both produce rows with placeholder labels, but for different reasons: reserve rows carry the metric's value, elimination rows carry a negative offset.

| Concept | Name |
|---|---|
| Strategy: don't distribute | **reserve** |
| Strategy: repeat full value | **elimination** |
| Value in entity column when metric isn't about that entity | **placeholder label** |
| Default placeholder label | `<Unallocated>` |
| Manifest setting | `placeholder_labels` (separate for reserve and elimination) |

One row per entity VALUE (not per entity), so row count = `entity.estimated_rows` for each entity with reserve or elimination metrics.

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
