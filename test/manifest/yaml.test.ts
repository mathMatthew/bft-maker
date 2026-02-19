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
          {
            name: "satisfaction_score",
            type: "rating",
            nature: "non-additive",
          },
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
    metric_clusters: [
      {
        name: "student_experience",
        metrics: ["tuition_paid", "satisfaction_score"],
        traversals: [],
      },
    ],
    bft_tables: [
      {
        name: "student_advising",
        grain: "Student × Class",
        grain_entities: ["Student", "Class"],
        clusters_served: ["student_experience"],
        estimated_rows: 120000,
        metrics: [
          {
            metric: "tuition_paid",
            strategy: "direct",
            sum_safe: true,
          },
        ],
        reserve_rows: [],
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
    assert.deepStrictEqual(parsed.relationships[0].between, [
      "Student",
      "Class",
    ]);
    assert.equal(parsed.relationships[0].type, "many-to-many");
  });

  it("handles empty sections gracefully", () => {
    const yaml = `
entities: []
relationships: []
`;
    const parsed = parseManifest(yaml);
    assert.deepStrictEqual(parsed.entities, []);
    assert.deepStrictEqual(parsed.relationships, []);
    assert.deepStrictEqual(parsed.metric_clusters, []);
    assert.deepStrictEqual(parsed.bft_tables, []);
  });

  it("rejects non-object YAML", () => {
    assert.throws(() => parseManifest("just a string"), {
      message: /Invalid manifest/,
    });
  });
});
