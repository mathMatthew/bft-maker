import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  BFT_OUTPUT_METADATA_KEY,
  BFT_SCHEMA_VERSION_KEY,
  BftOutputMetadataValidationError,
  assertValidOutputMetadataV1,
  canonicalOutputMetadataJson,
  outputMetadataFooter,
  produceOutputMetadataV1,
  type BftOutputMetadataV1,
  type RequestPlan,
} from "../../src/request-compiler/index.js";

const physicalColumns = ["account", "category", "amount", "headcount"];

function plan(): RequestPlan {
  return {
    schemaVersion: 1,
    dialect: "duckdb",
    id: "metadata_fixture",
    outputColumns: [
      { name: "account", type: "VARCHAR", role: "dimension" },
      { name: "category", type: "VARCHAR", role: "dimension" },
      { name: "amount", type: "BIGINT", role: "metric" },
      { name: "headcount", type: "BIGINT", role: "metric" },
    ],
    populations: [],
    metrics: [
      {
        name: "headcount",
        type: "BIGINT",
        aggregation: "sum",
        from: { kind: "relation", name: "accounts", alias: "a" },
        joins: [],
        expression: { kind: "column", alias: "a", column: "headcount" },
        dimensions: { account: { kind: "column", alias: "a", column: "account" } },
        reserveDimensions: { category: { kind: "literal", type: "VARCHAR", value: "<Unallocated>" } },
        predicates: [],
      },
      {
        name: "amount",
        type: "BIGINT",
        aggregation: "sum",
        from: { kind: "relation", name: "transactions", alias: "t" },
        joins: [],
        expression: { kind: "column", alias: "t", column: "amount" },
        dimensions: {
          account: { kind: "column", alias: "t", column: "account" },
          category: { kind: "column", alias: "t", column: "category" },
        },
        reserveDimensions: {},
        predicates: [],
      },
    ],
  };
}

function validMetadata(): BftOutputMetadataV1 {
  return produceOutputMetadataV1(plan());
}

describe("BFT output metadata version 1", () => {
  it("produces ordered sum routes and grouped reserve placeholders from a request plan", () => {
    const metadata = validMetadata();
    assert.deepEqual(metadata.dimensions, [
      { id: "account", column: "account" },
      { id: "category", column: "category" },
    ]);
    assert.deepEqual(metadata.measures.map((item) => item.id), ["amount", "headcount"]);
    assert.deepEqual(metadata.placeholders, [{
      column: "category",
      value: "<Unallocated>",
      kind: "reserve",
      measureIds: ["headcount"],
    }]);
  });

  it("serializes canonical footer values byte-for-byte", () => {
    const metadata = validMetadata();
    const footer = outputMetadataFooter(metadata, physicalColumns);
    assert.equal(footer[BFT_SCHEMA_VERSION_KEY], "1");
    assert.equal(footer[BFT_OUTPUT_METADATA_KEY], canonicalOutputMetadataJson(metadata));
    assert.equal(
      footer[BFT_OUTPUT_METADATA_KEY],
      canonicalOutputMetadataJson(JSON.parse(footer[BFT_OUTPUT_METADATA_KEY]) as BftOutputMetadataV1),
    );
    assert.match(footer[BFT_OUTPUT_METADATA_KEY], /^\{"dimensions":/);
  });

  it("rejects missing route columns, duplicate overrides, and visible internal components", () => {
    const metadata = validMetadata();
    metadata.measures[0].defaultAggregation = { kind: "sum", column: "missing" };
    metadata.measures[0].dimensionAggregations = [
      { dimensionId: "category", when: "collapsed", aggregation: { kind: "sum", column: "amount" } },
      { dimensionId: "category", when: "collapsed", aggregation: { kind: "sum", column: "amount" } },
    ];
    metadata.internalColumns = [{ column: "headcount", reason: "ratio_component" }];
    assert.throws(
      () => assertValidOutputMetadataV1(metadata, physicalColumns),
      (error: unknown) => error instanceof BftOutputMetadataValidationError
        && error.errors.some((item) => item.includes("missing physical column"))
        && error.errors.some((item) => item.includes("duplicates \"category\""))
        && error.errors.some((item) => item.includes("visible sum measure")),
    );
  });

  it("requires elimination placeholders and constraints to cover the same measure and hierarchy", () => {
    const metadata = validMetadata();
    metadata.placeholders.push({
      column: "category",
      value: "<Correction>",
      kind: "elimination",
      measureIds: ["amount"],
    });
    assert.throws(
      () => assertValidOutputMetadataV1(metadata, physicalColumns),
      /elimination placeholders and constraints disagree/,
    );
    metadata.filterConstraints = [{
      id: "category_filter",
      kind: "elimination",
      measureIds: ["amount"],
      hierarchy: { levels: ["category"], correctionsAtEveryHop: true },
      selectionMode: "all_or_single_hierarchy_node",
      allSelection: "no_predicate",
    }];
    assert.doesNotThrow(() => assertValidOutputMetadataV1(metadata, physicalColumns));
  });
});
