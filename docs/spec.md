# bft-maker

## What It Does

bft-maker takes a normalized relational schema and produces flat, pivot-safe tables that report authors can use without thinking about joins, fan-out, or double-counting. Every numeric column in the output is safe to `SUM`, or is explicitly flagged as requiring the `Sum / Sum` weighted-average pattern. Native `AVERAGE` is never correct and is never supported.

The system doesn't ask the user to understand data modeling. It asks them to answer one question: **what do you need to see together on the same report, and when you see it, what do you expect the numbers to mean?**

Everything else — the table count, the metric math, the generated code — follows from that answer.

---

## Architecture

The system has three pieces. Each is independently useful and testable.

```
Manifest  →  Validator  →  Code Generator
(contract)   (safety net)  (DuckDB / Spark SQL)
```

**The Manifest** is a declarative spec that fully describes the schema, the metrics, their traversal rules, and the table topology. It is the contract between the human-facing side and the machine-facing side. It is the thing you version control.

**The Validator** reads a manifest and catches every inconsistency before code is generated. Missing traversals, orphan metrics, impossible grains, relationships that reference nonexistent entities. If the validator passes, the code generator will produce correct output.

**The Code Generator** reads the manifest and produces executable transformation code plus a validation test suite. DuckDB is the primary target. Spark SQL is the secondary target for scale-out.

The manifest can be produced by hand, by an LLM conversation, or by any tool that conforms to the schema. The spec you're reading now — the strategies, the phases, the examples — is what an LLM needs as context to guide someone through building a manifest. There is no wizard UI.

---

## The Core Problem

A flat table has one grain — one definition of what a row represents. But organizations have many entities (Customers, Employees, Products, Departments), each with their own metrics. The moment you want metrics from different entities on the same report, every metric must exist on every row, even when a row "belongs" to a different entity.

Customer_Revenue is a Customer metric. If the table also carries Employee-level detail, Customer_Revenue needs a value on Employee rows. What value? That's not a technical question — it's a business question. The answer depends on what the report is trying to communicate.

bft-maker exists to force that question early, capture the answer in a manifest, and mechanically produce a table where every column's meaning is unambiguous.

This problem shows up in two forms:

**Unrelated entities sharing a table.** Customers and Employees have no direct relationship, but you want both on a scorecard sliced by Org and Month. Customer_Revenue still needs to mean something on Employee rows.

**Entities connected through many-to-many relationships.** Students enroll in Classes taught by Professors. A Student × Class × Professor grain creates rows where every metric must coexist, and fan-out from the relationships means values must be carefully distributed to avoid double-counting.

Both forms require the same resolution: for every metric, decide what it means on rows that aren't its own. The strategies for answering that question are identical regardless of whether the entities are related.

---

## Metric Strategies

Every metric in a BFT either lives naturally at the table's grain or is foreign to it. Foreign metrics — metrics that originate on a different entity than the row represents — must be assigned a strategy. The strategy determines what value appears on foreign rows and whether `SUM` is safe.

There are three strategies for additive metrics and one pattern for non-additive metrics.

### Reserve

The metric shows its value only on rows where the home entity is present. Foreign entity columns on those rows display a placeholder label (default `<Unallocated>`) — the value isn't about any specific foreign entity. On all other rows, the metric is zero.

Example: tuition (a Student metric) in a Student × Class table. Each student has a row with Class = `<Unallocated>` and their full tuition. Student × Class join rows show tuition = 0. Pivot by Student and you see each student's tuition naturally. Pivot by Class and the total sits on `<Unallocated>`.

`SUM` is safe — every value appears exactly once. Filtering out rows with placeholder labels drops the metric's total.

Reserve is the **default strategy**. It makes no assumptions about how a metric relates to foreign entities. It is the safe, assumption-free starting point.

### Elimination

The full metric value appears on every foreign row. Since this overcounts, the output includes rows where the foreign entity column shows a placeholder label and the metric carries a negative value that cancels the extra copies.

Example: class_budget (a Class metric) with elimination toward Student. Every Student × Class row shows the full class budget — useful when the number is context, not attribution. Each class also has a row with Student = `<Unallocated>` carrying a negative offset so that `SUM(class_budget)` returns the true total.

`SUM` is safe as long as rows with placeholder labels are included. Filtering them out produces a multiple of the true total.

Elimination is useful when users want to see a reference number alongside foreign detail. "Every employee in the Southwest can see that the region did $2M in revenue" — the $2M appears on every row, and the sum at the bottom still says $2M.

### Allocation

The total value is divided across foreign rows using a weight. `SUM` returns the correct total for any slice. The weight can come from a declared relationship (enrollment count, assignment share, FTE load) or from shared dimensions (headcount in the org, equal split).

Allocation is the only strategy that attributes a metric to individual foreign rows. It requires either a direct relationship or a deliberate decision to distribute on a shared dimension. The nature of the weight determines whether the attribution is precise or approximate — allocation by account assignment is precise; allocation by org headcount share is rough — but the mechanics are identical.

### Sum / Sum (Non-Additive Metrics)

For metrics that cannot be meaningfully split or summed (ratings, scores, percentages), the raw value is preserved on each row and a companion weight column is emitted that sums to 1.0 per unique entity. These columns are explicitly flagged as not SUM-safe. The correct aggregation is always:

```
Average = SUM(weighted_metric) / SUM(entity_weight)
```

Report authors must use this pattern. Native `AVERAGE` will produce wrong results.

---

## Counting

Counting is not a special case. A headcount column is a metric that happens to be made of 1s, and it must be assigned a strategy like any other metric.

There is no single "correct" headcount. A headcount allocated by instructional load (0.5 per professor in a co-taught class) answers a different question than a headcount using elimination (each student counted once). Both are legitimate. Both produce different numbers from the same `SUM`. The strategy assignment determines which counting question the table answers.

---

## Building the Manifest: Three Phases

The manifest is built through three sequential phases. Each phase produces a distinct section of the manifest. The phases are ordered — Phase B depends on Phase A, Phase C depends on Phase B — but the process is not strictly linear. Phase B often reveals missing relationships or unnecessary detail that sends the user back to revise Phase A. This loop is expected and means the process is working correctly.

These phases describe the logical sequence of decisions. They are not software components — they are the structure of the conversation (whether with an LLM or in your own head) that produces a manifest.

### Phase A: Inventory

*What data exists, how does it join, what metrics live where, and what level of detail do you need?*

This phase is discovery and scoping. The user identifies their entities, declares relationships between them (if any), provides rough cardinalities, lists every metric that might appear in any final report, and makes one critical decision per entity: **do you need entity-level detail, or just the rollup?**

This is the "click on the entity name" moment. If you want Customer Name on your report, you're carrying Customer-level detail — every customer becomes a row. If you only need Customer_Revenue as an org-level total, customers don't contribute rows. This decision determines which entities have "their own" rows in the final table and therefore which foreign-metric situations Phase B needs to resolve.

Metrics are declared on their home entity:

```yaml
entities:
  - name: Student
    role: leaf
    detail: true    # student-level rows in the output
    estimated_rows: 45000
    metrics:
      - name: tuition_paid
        type: currency
        nature: additive
      - name: satisfaction_score
        type: rating
        nature: non-additive

  - name: Class
    role: bridge
    detail: true
    estimated_rows: 1200
    metrics:
      - name: class_budget
        type: currency
        nature: additive

  - name: Professor
    role: leaf
    detail: true
    estimated_rows: 800
    metrics:
      - name: salary
        type: currency
        nature: additive

relationships:
  - name: Enrollment
    between: [Student, Class]
    type: many-to-many
    estimated_links: 120000

  - name: Assignment
    between: [Class, Professor]
    type: many-to-many
    estimated_links: 1800
```

Entities may or may not have relationships with each other. Six unrelated entities sharing only a time and org dimension is a valid input. Two entities connected through a many-to-many bridge is a valid input. A mix of both is a valid input. The engine handles the full spectrum.

Relationships are **undirected** — they describe what joins exist, not which way data flows. Direction comes later, implicitly, from each metric's propagation path.

Entity roles matter when relationships exist. A **bridge** entity sits between two **leaf** entities and mediates their many-to-many relationship. When no relationships exist, roles are informational only.

Cardinalities are declared upfront so the system can estimate output table sizes in Phase C. The fan-out multiplier for each many-to-many relationship is `links / bridge rows`.

**Phase A outputs:** A complete inventory of entities (with detail flags and metrics), relationships, and cardinalities. No strategy decisions have been made yet.

---

### Phase B: Propagation

*For each metric that isn't staying on its own rows (reserve), how does it spread to other entities, and what does it mean when it gets there?*

Every metric starts as **reserve** — its value stays with the home entity, showing zero on foreign rows. Reserve is the safe, assumption-free default. No propagation path needs to be declared for it.

The user upgrades metrics away from reserve one at a time:

> *"Tuition is currently reserve — professors won't see any tuition on their rows. Is that what you want?"*
>
> If no: *"Should every professor see the full tuition (as context), or should tuition be distributed across professors (as attribution)?"*
>
> If distributed: *"Tuition can be allocated through Enrollment to Class, then through Assignment to Professor. Should each hop use the relationship's weight, or equal split?"*

Each answer defines a **propagation path** — an ordered sequence of hops from the metric's home entity outward through relationships. The dialogue above would produce the first propagation below: tuition allocated Student → Class → Professor.

```yaml
propagations:
  # tuition_paid (Student) allocates outward through Enrollment to Class,
  # then through Assignment to Professor.
  - metric: tuition_paid
    path:
      - relationship: Enrollment
        target_entity: Class
        strategy: allocation
        weight: enrollment_share
      - relationship: Assignment
        target_entity: Professor
        strategy: allocation
        weight: assignment_share

  # class_budget (Class) uses elimination toward Student.
  # Does not propagate to Professor (reserve by default).
  - metric: class_budget
    path:
      - relationship: Enrollment
        target_entity: Student
        strategy: elimination

  # satisfaction_score (Student) uses sum_over_sum toward Class.
  - metric: satisfaction_score
    path:
      - relationship: Enrollment
        target_entity: Class
        strategy: sum_over_sum
        weight: satisfaction_weight

  # salary (Professor) stays reserve for all foreign entities.
  # Not listed — reserve is the default.
```

**Direction is implicit.** Each metric propagates outward from its home entity. The path lists target entities in order. Relationships are undirected; the metric's home determines the direction.

**Each metric has its own path.** Two metrics from the same entity can use different paths. Tuition might allocate through Enrollment, while satisfaction propagates through a different relationship.

**Entities not in the path get reserve.** If tuition propagates Student → Class but the table also includes Professor, tuition is automatically reserve for Professor. No declaration needed.

**The feedback loop.** Sometimes the user wants attribution but has no relationship to support it. "I want to see revenue per employee, but there's no link between Customers and Employees." This is a signal to go back to Phase A and either declare a missing relationship (maybe through an Account or Project bridge), create a multi-hop path through a shared dimension (like Org), or accept reserve.

**Shared dimensions.** Two unrelated entities can be connected through a shared entity like Month or Department. The propagation path goes through the shared entity using two relationships. The shared entity must be declared in the table's entities list, providing explicit alignment — no naming convention needed.

**Phase B outputs:** Propagation paths for every non-reserve metric. Every metric has an unambiguous meaning on every entity's rows. No commitment to table shape has been made yet.

---

### Phase C: Topology

*How many flat tables do you want, which entities and metrics does each one include, and how big will they be?*

This is a tradeoff decision, not a derivable answer. The options are presented; the user chooses.

#### What Gets Computed

Each table explicitly declares its **entities** and **metrics**. The grain is the declared entities list — `Student × Class × Professor` if those are the three entities declared. The system validates that every declared entity is reachable from the metrics' propagation paths, and that every entity touched by those paths is declared.

```
Table: department_financial
  Entities: [Student, Class, Professor]
  Metrics: [tuition_paid, class_budget, salary]
  Grain: Student × Class × Professor (from declared entities)
  Estimated rows: ~180,000

Table: student_experience
  Entities: [Student, Class]
  Metrics: [tuition_paid, satisfaction_score, class_budget]
  Grain: Student × Class (from declared entities)
  Estimated rows: ~120,000
```

Row estimates come from Phase A cardinalities:

- One M-M bridge: rows ≈ link count
- Two M-M bridges sharing an entity: rows ≈ links₁ × (links₂ / shared entity count)
- Each additional bridge: multiply by its fan-out

**Independent chains use UNION ALL, not cross product.** When two metrics have propagation chains that no single metric spans, the codegen emits UNION ALL. Their row counts are added, not multiplied. Example: Building × Month (60 rows) and Program × Month (36 rows) with no metric spanning Building-to-Program = 96 rows, not 180.

If merging tables would produce millions of rows, the user sees that cost before committing.

#### Simplification Suggestions

Before the user commits to a topology, score every decision made in Phases A and B by its cost to the output — row count, column count, number of allocation weights, and sparsity. Present the **top 5 simplifications** that would most reduce the cost of the final table(s).

Each suggestion is a specific, reversible change to a Phase A or Phase B decision, paired with a concrete description of what it saves and what it sacrifices.

```
Suggested simplifications for: financial_overview

1. Drop Professor detail (Phase A)
   Save: ~60,000 rows (removes Assignment fan-out)
   Cost: Cannot group by Professor. Salary becomes a class-level total.
   Changes: Grain drops from Student × Class × Professor
            to Student × Class.

2. Move salary to Reserve instead of Allocation (Phase B)
   Save: Eliminates salary allocation weights and removes
         the need for the Assignment relationship entirely.
   Cost: Salary is no longer attributable to individual classes
         or students — it stays at the Professor level.
   Changes: If no other metric needs Professor, this also
            enables simplification #1.

3. Remove tuition_paid from financial_overview cluster (Phase B)
   Save: One fewer allocation. Tuition already exists at native
         grain in the student_experience cluster.
   Cost: Cannot see tuition alongside salary on the same report.

4. Downgrade class_budget from Allocation to Elimination (Phase B)
   Save: Removes enrollment_count weighting. Simpler column.
   Cost: Every student row shows the full class budget instead
         of their share. Rows with placeholder labels carry offsets
         to keep `SUM` correct.

5. Roll up Student detail for financial_overview (Phase A)
   Save: ~179,000 rows. Table collapses to ~1,800 rows
         (one per Class × Professor assignment).
   Cost: Cannot see individual student names or tuition on
         this report. Student metrics become class-level totals.
```

The suggestions are ranked by impact — the biggest row or complexity reduction first. Each one traces back to a specific Phase A or Phase B decision, so the user knows exactly what they would revisit. Some suggestions are independent; others cascade (dropping Professor detail becomes possible only after moving salary to Reserve).

The user can accept any combination of suggestions, reject all of them, or use them as a starting point for further iteration through the A → B loop. The point is not to pressure the user toward simplicity — it's to make the cost of complexity visible before the table is built.

#### What the User Decides

The user picks a topology, informed by the cost estimates and the simplification suggestions. Each table declares both its entities and its metrics. The grain is the declared entities list. Row estimates follow from the entities and their relationships.

```yaml
bft_tables:
  - name: department_financial
    entities: [Student, Class, Professor]
    metrics: [tuition_paid, class_budget, salary]
    # Grain: Student × Class × Professor
    # Estimated rows: ~180,000

  - name: student_experience
    entities: [Student, Class]
    metrics: [tuition_paid, satisfaction_score, class_budget]
    # Grain: Student × Class
    # Estimated rows: ~120,000
```

**Phase C outputs:** The final table topology — each table's declared entities and metrics. The manifest is now complete and ready for code generation.

---

## Special Relationships

### Multi-Role Entities

When a person exists in two roles — e.g., as both a Student and a Professor — the system maintains identity separation through the manifest. Metrics are isolated by role: tuition stays on Student rows, salary stays on Professor rows. If a net-impact calculation is needed, a specific traversal rule in Phase B consolidates them using allocation.

### Co-Taught Classes (Multi-Owner Relationships)

When a class has multiple professors, the grain produces multiple rows per student enrollment. Metrics on those rows must be distributed to avoid fan-out distortion. Student headcount, for example, is allocated (e.g., 0.5 per professor) to correctly reflect instructional load when aggregating by professor.

---

## Code Generation

Once the manifest is complete, the code generator produces two things: **transformation code** and a **validation suite**.

### Transformation Code

The build plan fully specifies every transformation, so code generation is mechanical. Each strategy maps to a SQL template:

**Allocation** — a window function that computes a share and multiplies:
```sql
SELECT *,
  tuition_paid * (enrollment_share / SUM(enrollment_share) OVER (PARTITION BY class_id))
    AS tuition_paid_allocated
FROM base_grain
```

**Elimination** — the full value on every row, with a negating offset to keep `SUM` correct:
```sql
SELECT *, class_budget AS class_budget_elim FROM base_grain
UNION ALL
SELECT '<Unallocated>', ..., -1 * SUM(class_budget) + class_budget AS class_budget_elim
FROM base_grain GROUP BY ...
```

**Sum / Sum** — two columns emitted side by side:
```sql
SELECT *,
  satisfaction_score AS satisfaction_score_raw,
  1.0 / COUNT(*) OVER (PARTITION BY student_id) AS satisfaction_weight
FROM base_grain
```

The generator produces a DAG of independent steps — one per metric-strategy pair, with a final join. **The DAG approach is preferred** because each step is independently testable. When row counts look wrong, you can inspect one isolated transformation rather than reading through a monolithic file.

### Validation Suite

Every assertion is derivable directly from the manifest with no additional input:

- **Allocation metrics:** `SUM(allocated) == SUM(original)` for every entity group.
- **Elimination metrics:** Total `SUM` matches expected. Excluding rows with placeholder labels produces the expected overcounted total.
- **Reserve metrics:** Total `SUM` matches expected. Metric value is zero on all rows without placeholder labels.
- **Sum / Sum metrics:** Weights sum to expected value per entity (typically 1.0).
- **Row counts:** Actual output rows match estimated rows within a tolerance band.

If any test fails, the build fails, and the error message references the specific metric and strategy that broke.

### Output

The generator writes numbered SQL files and a runner:

```
output/
├── 01_base_enrollment_join.sql
├── 02_allocate_tuition_paid.sql
├── 03_allocate_salary.sql
├── 04_eliminate_class_budget.sql
├── 05_reserve_overhead.sql
├── 06_sum_over_sum_satisfaction.sql
├── 07_final_assembly.sql
├── 08_validate.sql
├── run.sh
└── manifest.yaml
```

---

## What Report Authors Need to Know

| Column Type | Safe to SUM? | Condition |
|---|---|---|
| Allocated metric | Yes | Always correct for any slice |
| Elimination metric | Yes | Rows with placeholder labels must be included |
| Reserve metric | Yes | Rows with placeholder labels must be included |
| Sum / Sum metric | No | Must use `SUM(weighted) / SUM(weight)` |
| Count column | Depends | Follows the same rules as its assigned strategy |

Some entity columns contain placeholder labels (default `<Unallocated>`, configurable per manifest). These appear on rows where a metric's value isn't attributed to a specific entity — for example, a student's tuition appears on a row where the Class column is `<Unallocated>` because tuition isn't about any specific class. For elimination and reserve metrics, filtering out rows with placeholder labels will silently produce wrong sums. All such columns carry a persistent flag in the output schema indicating this dependency.

---

## Summary

bft-maker is a pipeline with three decision phases and a mechanical code generator.

**Phase A** inventories the data: entities (with their metrics), joins, cardinalities, and the level of detail needed per entity.

**Phase B** resolves propagation: for each metric that isn't staying reserve, define a propagation path — which relationships to traverse, what strategy at each hop. Everything starts as reserve. Phase B may loop back to Phase A when propagation questions reveal missing relationships or unnecessary detail.

**Phase C** resolves topology: how many tables, which entities and metrics each one declares, and at what row cost. The grain is the declared entities list. The user chooses. The manifest is complete.

Then the machine takes over:

**The Validator** catches every inconsistency in the manifest before code runs.

**The Code Generator** produces transformation SQL and validation tests mechanically from the manifest.

The core insight is that table design is a reporting question, not a modeling question. The strategies — Reserve, Elimination, Allocation, and Sum / Sum — are not data engineering techniques. They are answers to a business question: when a metric shows up on rows that aren't its own, what should it mean? bft-maker forces that question early, captures the answer once, and produces a table where every column is unambiguous and every sum is correct.
