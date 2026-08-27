/**
 * Validate the JS aggregation logic from bft-explorer.html
 * against the Python/DuckDB ground truth.
 *
 * Runs the same aggregate() function the browser uses,
 * then compares results.
 */
import { readFileSync } from 'node:fs';

const DATA = JSON.parse(readFileSync('data/library/viz-data.json', 'utf-8'));

// ── Same aggregation logic as the HTML ───────────────────────
const sumSumMetrics = { avg_fine_per_checkout: 'avg_fine_per_checkout_weight' };
const regularMetrics = ['membership_fee', 'replacement_cost', 'fine_amount', 'hold_count'];
const allMetrics = [...regularMetrics, 'avg_fine_per_checkout'];

function aggregate(tblRows, tblCols, dims, selectedDims) {
  const groupDimDefs = dims.filter(d => selectedDims.has(d.key));

  // Build columns
  const cols = [];
  for (const d of groupDimDefs) { cols.push(d.idCol, d.labelCol); }
  const metricCols = tblCols.filter(c => allMetrics.includes(c));
  cols.push(...metricCols);

  // If all dims selected, no aggregation
  if (groupDimDefs.length === dims.length) {
    return { columns: cols, rows: tblRows };
  }

  // Group
  const groups = new Map();
  for (const row of tblRows) {
    const keyParts = groupDimDefs.map(d => row[d.idCol]);
    const key = keyParts.join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  // Aggregate
  const aggRows = [];
  for (const [, groupRows] of groups) {
    const out = {};
    for (const d of groupDimDefs) {
      out[d.idCol] = groupRows[0][d.idCol];
      out[d.labelCol] = groupRows[0][d.labelCol];
    }
    for (const col of metricCols) {
      if (sumSumMetrics[col]) {
        const weightCol = sumSumMetrics[col];
        let sumVW = 0, sumW = 0;
        for (const r of groupRows) {
          const w = r[weightCol] || 0;
          sumVW += (r[col] || 0) * w;
          sumW += w;
        }
        out[col] = sumW > 0 ? sumVW / sumW : 0;
      } else {
        out[col] = groupRows.reduce((s, r) => s + (r[col] || 0), 0);
      }
    }
    aggRows.push(out);
  }

  return { columns: cols, rows: aggRows };
}

// ── Source totals ─────────────────────────────────────────────
const sourceTotals = {
  membership_fee:   DATA.patrons.rows.reduce((s, r) => s + r.membership_fee, 0),
  replacement_cost: DATA.books.rows.reduce((s, r) => s + r.replacement_cost, 0),
  fine_amount:      DATA.checkouts.rows.reduce((s, r) => s + r.fine_amount, 0),
  hold_count:       DATA.holds.rows.reduce((s, r) => s + r.hold_count, 0),
};

// ── Table definitions ─────────────────────────────────────────
const tableDefs = {
  patron_book_report: [
    { key: 'patron', idCol: 'patron_id', labelCol: 'patron_name' },
    { key: 'book',   idCol: 'book_id',   labelCol: 'book_name' },
  ],
  patron_author_report: [
    { key: 'patron', idCol: 'patron_id', labelCol: 'patron_name' },
    { key: 'book',   idCol: 'book_id',   labelCol: 'book_name' },
    { key: 'author', idCol: 'author_id', labelCol: 'author_name' },
  ],
};

// ── Generate all subsets ──────────────────────────────────────
function* subsets(arr) {
  for (let mask = (1 << arr.length) - 1; mask >= 0; mask--) {
    yield arr.filter((_, i) => mask & (1 << i));
  }
}

let pass = 0, fail = 0;
const failures = [];

for (const [tblName, dims] of Object.entries(tableDefs)) {
  const tbl = DATA[tblName];
  const dimKeys = dims.map(d => d.key);

  for (const subset of subsets(dimKeys)) {
    const selected = new Set(subset);
    const grainLabel = subset.length > 0 ? subset.map(s => s[0].toUpperCase() + s.slice(1)).join(' x ') : 'Grand Total';

    const agg = aggregate(tbl.rows, tbl.columns, dims, selected);

    console.log(`\n${tblName} | ${grainLabel} (${agg.rows.length} rows)`);

    // Check additive metric SUMs
    for (const metric of regularMetrics) {
      if (!agg.columns.includes(metric)) continue;
      const bftSum = agg.rows.reduce((s, r) => s + (Number(r[metric]) || 0), 0);
      const expected = sourceTotals[metric];
      const match = Math.abs(bftSum - expected) < 0.01;
      const status = match ? 'PASS' : 'FAIL';
      console.log(`  SUM(${metric}): ${bftSum.toFixed(2)} vs ${expected.toFixed(2)} -> ${status}`);
      if (match) pass++; else { fail++; failures.push(`${tblName}/${grainLabel}/SUM(${metric}): ${bftSum} vs ${expected}`); }
    }

    // Check headings
    const expectedCols = [];
    for (const d of dims) {
      if (selected.has(d.key)) { expectedCols.push(d.idCol, d.labelCol); }
    }
    const expectedMetricCols = tbl.columns.filter(c => allMetrics.includes(c));
    expectedCols.push(...expectedMetricCols);
    const headingMatch = JSON.stringify(agg.columns) === JSON.stringify(expectedCols);
    console.log(`  Headings: ${headingMatch ? 'PASS' : 'FAIL'} ${JSON.stringify(agg.columns)}`);
    if (headingMatch) pass++; else { fail++; failures.push(`${tblName}/${grainLabel}/headings: got ${JSON.stringify(agg.columns)}, expected ${JSON.stringify(expectedCols)}`); }
  }
}

console.log(`\n${'='.repeat(60)}`);
console.log(`JS AGGREGATION: ${pass} passed, ${fail} failed`);
console.log('='.repeat(60));
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
} else {
  console.log('\nAll JS aggregation checks passed!');
}
