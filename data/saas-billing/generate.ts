/**
 * Generate synthetic SaaS billing data for BFT testing.
 * Run: npx tsx data/saas-billing/generate.ts
 *
 * Domain: B2B SaaS platform — Customers, Plans, Subscriptions, Billing.
 * Tests stock metrics (MRR, seats) vs. flow metrics (billed, paid),
 * time dimension with weighted-average summarization, and allocation
 * with seat_count weights.
 *
 * Entity graph: Plan ←(Subscription)→ Customer ←(Billing)→ Month
 * Customer is the bridge between Plan (leaf) and Month (time leaf).
 */
import * as fs from "node:fs";
import * as path from "node:path";

const DIR = path.dirname(new URL(import.meta.url).pathname);

// Deterministic pseudo-random (seeded LCG)
let seed = 42;
function rand(): number {
  seed = (seed * 1664525 + 1013904223) & 0x7fffffff;
  return seed / 0x7fffffff;
}
function randInt(min: number, max: number): number {
  return Math.floor(rand() * (max - min + 1)) + min;
}

// --- Customers (12) ---
const customerNames = [
  "Acme Corp", "Globex Inc", "Initech", "Umbrella Co", "Stark Industries",
  "Wayne Ent", "Cyberdyne", "Wonka Ltd", "Dunder Mifflin", "Pied Piper",
  "Hooli", "Prestige Worldwide",
];
const customers = customerNames.map((name, i) => ({
  customer_id: i + 1,
  name,
  annual_contract_value: randInt(10, 100) * 1000, // $10k-$100k
}));

// --- Plans (4) ---
const planDefs = [
  { name: "Starter", monthly_rate: 99 },
  { name: "Professional", monthly_rate: 299 },
  { name: "Enterprise", monthly_rate: 999 },
  { name: "Ultimate", monthly_rate: 2499 },
];
const plans = planDefs.map((p, i) => ({
  plan_id: i + 1,
  name: p.name,
  monthly_rate: p.monthly_rate,
}));

// --- Months (6) ---
const months = Array.from({ length: 6 }, (_, i) => ({
  month_id: i + 1,
  month_label: `2024-${String(i + 1).padStart(2, "0")}`,
  month_date: `2024-${String(i + 1).padStart(2, "0")}-01`,
}));

// --- Subscriptions (~15: customer × plan) ---
// Each customer has 1-2 subscriptions on different plans.
// Stock metrics: seat_count and mrr (point-in-time, not summable across time).
const subscriptions: {
  subscription_id: number;
  customer_id: number;
  plan_id: number;
  seat_count: number;
  mrr: number;
}[] = [];

let subId = 0;
for (const c of customers) {
  const numSubs = randInt(1, 2);
  const usedPlans = new Set<number>();
  for (let s = 0; s < numSubs; s++) {
    let planId: number;
    do {
      planId = randInt(1, plans.length);
    } while (usedPlans.has(planId));
    usedPlans.add(planId);

    const seats = randInt(1, 20);
    const plan = plans[planId - 1];
    subId++;
    subscriptions.push({
      subscription_id: subId,
      customer_id: c.customer_id,
      plan_id: planId,
      seat_count: seats,
      mrr: plan.monthly_rate * seats,
    });
  }
}

// --- Billing (~50: customer × month, flow metrics) ---
// Each customer gets a billing record for months they're active.
// Aggregated from invoices: amount_billed and amount_paid.
const billings: {
  customer_id: number;
  month_id: number;
  amount_billed: number;
  amount_paid: number;
}[] = [];

for (const c of customers) {
  // Customers are active for 4-6 of the 6 months
  const startMonth = randInt(1, 2);
  const endMonth = rand() < 0.3 ? randInt(4, 5) : 6;
  for (let m = startMonth; m <= endMonth; m++) {
    // Sum across their subscriptions for this month
    const customerSubs = subscriptions.filter((s) => s.customer_id === c.customer_id);
    const billed = customerSubs.reduce((sum, s) => sum + s.mrr, 0);
    // 85% pay in full, 15% partial
    const paid = rand() < 0.85 ? billed : Math.round(billed * randInt(70, 95) / 100);
    billings.push({
      customer_id: c.customer_id,
      month_id: m,
      amount_billed: billed,
      amount_paid: paid,
    });
  }
}

// --- Write CSVs ---
function writeCsv(filename: string, headers: string[], rows: Record<string, unknown>[]) {
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => String(row[h] ?? "")).join(","));
  }
  const filepath = path.join(DIR, filename);
  fs.writeFileSync(filepath, lines.join("\n") + "\n");
  console.log(`  ${filename}: ${rows.length} rows`);
}

console.log("Generating SaaS billing data...");
writeCsv("customers.csv", ["customer_id", "name", "annual_contract_value"], customers);
writeCsv("plans.csv", ["plan_id", "name", "monthly_rate"], plans);
writeCsv("months.csv", ["month_id", "month_label", "month_date"], months);
writeCsv("subscriptions.csv", ["subscription_id", "customer_id", "plan_id", "seat_count", "mrr"], subscriptions);
writeCsv("billings.csv", ["customer_id", "month_id", "amount_billed", "amount_paid"], billings);

// Print summary
console.log(`\nSummary:`);
console.log(`  Customers: ${customers.length}`);
console.log(`  Plans: ${plans.length}`);
console.log(`  Months: ${months.length}`);
console.log(`  Subscriptions: ${subscriptions.length}`);
console.log(`  Billings: ${billings.length}`);
console.log(`  Total ACV: $${customers.reduce((s, x) => s + x.annual_contract_value, 0).toLocaleString()}`);
console.log(`  Total billed: $${billings.reduce((s, x) => s + x.amount_billed, 0).toLocaleString()}`);
console.log(`  Total paid: $${billings.reduce((s, x) => s + x.amount_paid, 0).toLocaleString()}`);
console.log(`  Total MRR: $${subscriptions.reduce((s, x) => s + x.mrr, 0).toLocaleString()}`);
console.log(`  Total seats: ${subscriptions.reduce((s, x) => s + x.seat_count, 0)}`);
