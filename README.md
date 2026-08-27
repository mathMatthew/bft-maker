# bft-maker

**Big Flat Table maker.** Takes a normalized relational schema and produces flat, pivot-safe reporting tables where every numeric column is safe to `SUM` — or is explicitly flagged as requiring the Sum/Sum weighted-average pattern.

The core problem: you have metrics on different entities (Students, Classes, Professors) and you want them all on the same report. When a metric from one entity appears on another entity's rows, it needs a rule for what value to show there. bft-maker forces you to declare that rule upfront — the four strategies below — then mechanically generates the SQL that implements it.

---

## Install

```bash
git clone <repo>
cd bft-maker
npm install
npm run build
npm link          # makes `bft-maker` available on PATH
```

Requires Node.js 18+ and a DuckDB file to introspect.

---

## Quick start

**1. See what's in your database**

```bash
bft-maker introspect --db mydata.duckdb
```

Prints detected entities, junction tables, metrics, and foreign-key relationships.

**2. Build a manifest interactively**

```bash
bft-maker wizard --db mydata.duckdb --output manifest.yaml
```

Steps through data model → strategy matrix → weights → table composition, then writes a YAML manifest.

**3. Generate SQL**

```bash
bft-maker generate --manifest manifest.yaml --output sql/
```

Writes one `.sql` file per BFT table plus a `run.sh` that executes them. By
default the generated SQL loads the source CSVs into an in-memory database.

**Generate against an existing database instead:**

```bash
bft-maker generate --manifest manifest.yaml --source database --output sql/
./sql/run.sh mydata.duckdb
```

Database mode emits no CSV loader and assumes the source tables already exist.
The runner takes the database path at execution time, so one generated
directory works against any copy of the database.

**Validate a manifest without generating:**

```bash
bft-maker validate --manifest manifest.yaml
```

**Compile a request plan** into materialization SQL, an exact-count query, and
version 1 output metadata:

```bash
bft-maker compile-request --plan data/ipeds/request-plan.yaml --output out/
```

---

## The four strategies

Every metric in the output either lives naturally at the table's grain or is *foreign* to it (its home entity isn't the row's entity). Foreign metrics must be assigned a strategy.

| Strategy | What it does | SUM safe? | Use when |
|---|---|---|---|
| **Reserve** | Metric value stays on home-entity rows; zero everywhere else | Yes | Default. You don't want the metric attributed to foreign rows. |
| **Elimination** | Full value on every combination row; correction row offsets the overcount | Yes (include correction rows) | You want the number visible as context on every row ("every employee can see the region total") |
| **Allocation** | Value is divided across combination rows by a weight column | Yes | You want to attribute a share of the metric to each combination (e.g. allocate budget by enrollment share) |
| **Sum/Sum** | Raw non-additive value preserved; companion weight column emitted | No — use `SUM(val×wt)/SUM(wt)` | Ratings, scores, percentages — anything where averaging is conceptually correct |

**Reserve is the default.** Start there and only upgrade a metric to another strategy when you have a specific reason.

---

## Manifest format

The manifest is a YAML file that declares entities, relationships, metric strategies, and output table composition. See [`data/university/manifest.yaml`](data/university/manifest.yaml) for a complete annotated example, and [`docs/spec.md`](docs/spec.md) for the full specification.

```yaml
entities:
  - name: Student
    role: leaf
    detail: true
    estimated_rows: 45000
    metrics:
      - name: tuition_paid
        type: currency
        nature: additive

relationships:
  - name: Enrollment
    between: [Student, Class]
    type: many-to-many
    estimated_links: 120000

propagations:
  - metric: tuition_paid
    path:
      - relationship: Enrollment
        target_entity: Class
        strategy: allocation
        weight: enrollment_share

bft_tables:
  - name: student_class_financial
    entities: [Student, Class]
    metrics: [tuition_paid, class_budget]
```

---

## Using an LLM to build the manifest

The wizard is one path. Another: paste [`docs/spec.md`](docs/spec.md) into Claude (or any capable LLM) along with your schema (table names, columns, rough row counts) and describe what you want to see on reports. The LLM can guide you through strategy decisions and produce a manifest YAML directly. Then:

```bash
bft-maker validate --manifest manifest.yaml   # check it
bft-maker wizard --db mydata.duckdb --manifest manifest.yaml  # review/edit in TUI
bft-maker generate --manifest manifest.yaml   # generate SQL
```

The spec was written to serve as LLM context. The strategies section and the three-phase build process map directly to the questions an LLM needs to ask.

---

## Example datasets

| Dataset | What it exercises |
|---|---|
| `data/university/` | Student × Class × Professor, all four strategies |
| `data/university-ops/` | Operational variant of the university schema |
| `data/northwind/` | Classic order-management schema |
| `data/semi-additive/` | Stock/balance metrics |
| `data/single-entity/` | Single-entity manifests |
| `data/ipeds/` | Request-compiler plan for the IPEDS reference request |

---

## Development

```bash
npm run build   # compile TypeScript
npm test        # compile + run tests
npm run dev     # tsc watch mode
```

Tests use a snapshot approach: fixture manifest in → expected SQL out. See `test/` for examples.
