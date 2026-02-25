import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  parseManifest,
  serializeManifest,
} from "../../src/manifest/yaml.js";
import type { Manifest } from "../../src/manifest/types.js";

function universityManifest(): Manifest {
  return {
    entities: [
      {
        name: "Student",
        role: "leaf",
        detail: true,
        estimated_rows: 45000,
        metrics: [
          { name: "tuition_paid", type: "currency", nature: "additive" },
          { name: "satisfaction_score", type: "rating", nature: "non-additive" },
        ],
      },
      {
        name: "Class",
        role: "bridge",
        detail: true,
        estimated_rows: 1200,
        metrics: [
          { name: "class_budget", type: "currency", nature: "additive" },
        ],
      },
    ],
    relationships: [
      {
        name: "Enrollment",
        between: ["Student", "Class"],
        type: "many-to-many",
        estimated_links: 120000,
      },
    ],
    propagations: [
      {
        metric: "tuition_paid",
        path: [
          { relationship: "Enrollment", target_entity: "Class", strategy: "allocation", weight: "enrollment_share" },
        ],
      },
    ],
    bft_tables: [
      {
        name: "student_experience",
        entities: ["Student", "Class"],
        metrics: ["tuition_paid", "satisfaction_score"],
      },
    ],
  };
}

describe("YAML round-trip", () => {
  it("serializes and parses back to equivalent manifest", () => {
    const original = universityManifest();
    const yaml = serializeManifest(original);
    const parsed = parseManifest(yaml);
    assert.deepStrictEqual(parsed, original);
  });

  it("parses entities correctly", () => {
    const original = universityManifest();
    const yaml = serializeManifest(original);
    const parsed = parseManifest(yaml);
    assert.equal(parsed.entities.length, 2);
    assert.equal(parsed.entities[0].name, "Student");
    assert.equal(parsed.entities[0].role, "leaf");
    assert.equal(parsed.entities[0].detail, true);
    assert.equal(parsed.entities[0].estimated_rows, 45000);
    assert.equal(parsed.entities[0].metrics.length, 2);
  });

  it("parses relationships correctly", () => {
    const original = universityManifest();
    const yaml = serializeManifest(original);
    const parsed = parseManifest(yaml);
    assert.equal(parsed.relationships.length, 1);
    assert.equal(parsed.relationships[0].name, "Enrollment");
    assert.deepStrictEqual(parsed.relationships[0].between, ["Student", "Class"]);
    assert.equal(parsed.relationships[0].type, "many-to-many");
  });

  it("parses propagations correctly", () => {
    const original = universityManifest();
    const yaml = serializeManifest(original);
    const parsed = parseManifest(yaml);
    assert.equal(parsed.propagations.length, 1);
    assert.equal(parsed.propagations[0].metric, "tuition_paid");
    assert.equal(parsed.propagations[0].path.length, 1);
    assert.equal(parsed.propagations[0].path[0].strategy, "allocation");
  });

  it("handles empty sections gracefully", () => {
    const yaml = `
entities: []
relationships: []
`;
    const parsed = parseManifest(yaml);
    assert.deepStrictEqual(parsed.entities, []);
    assert.deepStrictEqual(parsed.relationships, []);
    assert.deepStrictEqual(parsed.propagations, []);
    assert.deepStrictEqual(parsed.bft_tables, []);
  });

  it("expands metric arrays in propagations", () => {
    const yaml = `
entities:
  - name: Student
    role: leaf
    detail: true
    estimated_rows: 100
    metrics:
      - name: tuition_paid
        type: currency
        nature: additive
      - name: fees
        type: currency
        nature: additive
      - name: deposits
        type: currency
        nature: additive
relationships:
  - name: Enrollment
    between: [Student, Class]
    type: many-to-many
    estimated_links: 500
propagations:
  - metric: [tuition_paid, fees, deposits]
    path:
      - relationship: Enrollment
        target_entity: Class
        strategy: allocation
        weight: enrollment_share
`;
    const parsed = parseManifest(yaml);
    assert.equal(parsed.propagations.length, 3);
    assert.equal(parsed.propagations[0].metric, "tuition_paid");
    assert.equal(parsed.propagations[1].metric, "fees");
    assert.equal(parsed.propagations[2].metric, "deposits");
    // All share the same path structure
    for (const prop of parsed.propagations) {
      assert.equal(prop.path.length, 1);
      assert.equal(prop.path[0].strategy, "allocation");
      assert.equal(prop.path[0].target_entity, "Class");
    }
  });

  it("mixes single-metric and array-metric propagations", () => {
    const yaml = `
entities: []
propagations:
  - metric: [a, b]
    path:
      - relationship: R1
        target_entity: X
        strategy: allocation
        weight: w
  - metric: c
    path:
      - relationship: R2
        target_entity: Y
        strategy: elimination
`;
    const parsed = parseManifest(yaml);
    assert.equal(parsed.propagations.length, 3);
    assert.equal(parsed.propagations[0].metric, "a");
    assert.equal(parsed.propagations[1].metric, "b");
    assert.equal(parsed.propagations[2].metric, "c");
    assert.equal(parsed.propagations[2].path[0].strategy, "elimination");
  });

  it("rejects non-object YAML", () => {
    assert.throws(() => parseManifest("just a string"), {
      message: /Invalid manifest/,
    });
  });

  it("parses placeholder_labels with defaults for missing fields", () => {
    const yaml = `
entities: []
placeholder_labels:
  reserve: "<N/A>"
`;
    const parsed = parseManifest(yaml);
    assert.equal(parsed.placeholder_labels?.reserve, "<N/A>");
    assert.equal(parsed.placeholder_labels?.elimination, "<Unallocated>");
  });

  it("round-trips placeholder_labels", () => {
    const original = universityManifest();
    original.placeholder_labels = { reserve: "<Reserve>", elimination: "<Offset>" };
    const yaml = serializeManifest(original);
    const parsed = parseManifest(yaml);
    assert.equal(parsed.placeholder_labels?.reserve, "<Reserve>");
    assert.equal(parsed.placeholder_labels?.elimination, "<Offset>");
  });
});
