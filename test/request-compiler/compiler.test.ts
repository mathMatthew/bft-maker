import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  compileRequest,
  validateRequestPlan,
  type RequestPlan,
} from "../../src/request-compiler/index.js";

function fixture(): RequestPlan {
  return {
    schemaVersion: 1,
    dialect: "duckdb",
    id: "safe_sparse_request",
    outputColumns: [
      { name: "account_name", type: "VARCHAR", role: "dimension" },
      { name: "category", type: "VARCHAR", role: "dimension" },
      { name: "amount", type: "BIGINT", role: "metric" },
      { name: "headcount", type: "BIGINT", role: "metric" },
    ],
    populations: [],
    metrics: [
      {
        name: "amount",
        type: "BIGINT",
        aggregation: "sum",
        from: { kind: "relation", schema: "main", name: "transactions", alias: "t" },
        joins: [],
        expression: { kind: "column", alias: "t", column: "amount" },
        dimensions: {
          account_name: { kind: "column", alias: "t", column: "account_name" },
          category: { kind: "column", alias: "t", column: "category" },
        },
        reserveDimensions: {},
        predicates: [{
          expression: { kind: "column", alias: "t", column: "account_name" },
          operator: "equals",
          value: { kind: "literal", type: "VARCHAR", value: "O'Reilly" },
        }],
      },
      {
        name: "headcount",
        type: "BIGINT",
        aggregation: "sum",
        from: { kind: "relation", schema: "main", name: "accounts", alias: "a" },
        joins: [],
        expression: { kind: "column", alias: "a", column: "headcount" },
        dimensions: {
          account_name: { kind: "column", alias: "a", column: "account_name" },
        },
        reserveDimensions: {
          category: { kind: "literal", type: "VARCHAR", value: "<Unallocated>" },
        },
        predicates: [],
      },
    ],
    orderBy: [{ column: "account_name", direction: "asc" }],
  };
}

describe("request compiler", () => {
  it("compiles independent metric grains as a sparse union with typed nulls", () => {
    const result = compileRequest(fixture());

    assert.match(result.materializationSql, /UNION ALL/);
    assert.match(result.materializationSql, /CAST\(NULL AS BIGINT\) AS "headcount"/);
    assert.match(result.materializationSql, /CAST\('<Unallocated>' AS VARCHAR\)/);
    assert.match(result.materializationSql, /CAST\("t"\."category" AS VARCHAR\) AS "category"/);
    assert.match(result.materializationSql, /CAST\('O''Reilly' AS VARCHAR\)/);
    assert.match(result.materializationSql, /ORDER BY "account_name" ASC$/);
    assert.ok(!result.countSql.includes("ORDER BY"));
    assert.match(result.countSql, /SELECT COUNT\(\*\)::BIGINT AS "row_count" FROM/);
    assert.deepEqual(result.metadata.reserveDimensions, {
      amount: [],
      headcount: ["category"],
    });
  });

  it("rejects unsafe identifiers, unknown aliases, and incomplete dimension placement", () => {
    const plan = fixture();
    plan.outputColumns[0].name = "account_name; DROP TABLE accounts";
    plan.metrics[0].expression = { kind: "column", alias: "missing", column: "amount" };
    delete plan.metrics[1].reserveDimensions.category;

    const errors = validateRequestPlan(plan);
    assert.ok(errors.some((error) => error.includes("valid SQL identifier")));
    assert.ok(errors.some((error) => error.includes('unknown alias "missing"')));
    assert.ok(errors.some((error) => error.includes("exactly one of dimensions.category")));
  });

  it("rejects a population reference before that population is defined", () => {
    const plan = fixture();
    plan.populations.push({
      name: "derived",
      from: { kind: "population", name: "later", alias: "p" },
      joins: [],
      projections: { account_name: { kind: "column", alias: "p", column: "account_name" } },
      predicates: [],
    });

    const errors = validateRequestPlan(plan);
    assert.ok(errors.some((error) => error.includes('unknown population "later"')));
  });

  it("rejects joins that do not connect the new source alias", () => {
    const plan = fixture();
    plan.metrics[0].joins.push({
      kind: "inner",
      source: { kind: "relation", schema: "main", name: "accounts", alias: "a" },
      on: [{
        left: { alias: "t", column: "account_name" },
        right: { alias: "t", column: "account_name" },
      }],
    });

    const errors = validateRequestPlan(plan);
    assert.ok(errors.some((error) => error.includes('must connect new alias "a"')));
  });

  it("requires non-null reserve literals with the declared dimension type", () => {
    const plan = fixture();
    plan.metrics[1].reserveDimensions.category = {
      kind: "literal",
      type: "INTEGER",
      value: null,
    };

    const errors = validateRequestPlan(plan);
    assert.ok(errors.some((error) => error.includes("cannot be null")));
    assert.ok(errors.some((error) => error.includes("does not match output column type VARCHAR")));

    (plan.metrics[1].reserveDimensions as Record<string, unknown>).category = {
      kind: "column",
      alias: "a",
      column: "category",
    };
    assert.ok(validateRequestPlan(plan).some((error) => error.includes("must be a typed literal")));
  });

  it("rejects null binary comparisons and unknown plan fields", () => {
    const plan = fixture();
    plan.metrics[0].predicates[0].value = { kind: "literal", type: "VARCHAR", value: null };
    (plan as RequestPlan & { rawSql?: string }).rawSql = "DROP TABLE accounts";

    const errors = validateRequestPlan(plan);
    assert.ok(errors.some((error) => error.includes("cannot be null; use is_null")));
    assert.ok(errors.some((error) => error.includes("requestPlan.rawSql is not supported")));
  });

  it("rejects column predicate values and primitive/type mismatches", () => {
    const plan = fixture();
    plan.metrics[0].predicates[0].value = {
      kind: "literal",
      type: "INTEGER",
      value: "not_an_integer",
    } as unknown as NonNullable<typeof plan.metrics[0]["predicates"][0]["value"]>;
    assert.ok(validateRequestPlan(plan).some((error) => error.includes("must be numeric for INTEGER")));

    plan.metrics[0].predicates[0].value = {
      kind: "column",
      alias: "t",
      column: "account_name",
    } as unknown as NonNullable<typeof plan.metrics[0]["predicates"][0]["value"]>;
    assert.ok(validateRequestPlan(plan).some((error) => error.includes("must be a typed literal")));
  });

  it("reports malformed YAML-shaped collections instead of throwing TypeError", () => {
    const malformed = {
      ...fixture(),
      outputColumns: [null],
      populations: [null],
      metrics: [null],
      orderBy: [null],
    } as unknown as RequestPlan;

    assert.doesNotThrow(() => validateRequestPlan(malformed));
    assert.ok(validateRequestPlan(malformed).length >= 4);
  });

  it("rejects case-insensitive SQL namespace collisions", () => {
    const plan = fixture();
    plan.populations.push({
      name: "__BFT_METRIC_01_amount",
      from: { kind: "relation", schema: "main", name: "accounts", alias: "Source" },
      joins: [],
      projections: { Account: { kind: "column", alias: "source", column: "account_name" } },
      predicates: [],
    });
    plan.outputColumns.push({ name: "ACCOUNT_NAME", type: "VARCHAR", role: "dimension" });

    const errors = validateRequestPlan(plan);
    assert.ok(errors.some((error) => error.includes('reserved compiler namespace "__bft_"')));
    assert.ok(errors.some((error) => error.includes('duplicates "ACCOUNT_NAME"')));
  });
});
