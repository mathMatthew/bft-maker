import * as fs from "node:fs";
import * as yaml from "js-yaml";
import type { RequestPlan } from "./types.js";

export function parseRequestPlan(text: string): RequestPlan {
  const value = yaml.load(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid request plan: expected a YAML object");
  }
  return value as RequestPlan;
}

export function loadRequestPlan(path: string): RequestPlan {
  return parseRequestPlan(fs.readFileSync(path, "utf8"));
}
