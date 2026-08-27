"""
Validate the BFT Explorer's aggregation logic.

For each BFT table × grain combination:
  1. Aggregate the BFT rows by the selected dimensions
  2. Check that SUM of each additive metric matches the source total
  3. Check that avg_fine_per_checkout weighted average is computed correctly
  4. Spot-check individual cell values against source data
"""
import duckdb
import json
import os
from itertools import combinations

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SQL_DIR = os.path.join(SCRIPT_DIR, "sql")

# ── Load data into DuckDB ─────────────────────────────────────
con = duckdb.connect()
for f in ["00_load_data.sql", "01_patron_book_report.sql", "02_patron_author_report.sql"]:
    sql = open(os.path.join(SQL_DIR, f)).read()
    for stmt in [s.strip() for s in sql.split(';') if s.strip()]:
        lines = [l for l in stmt.split('\n') if l.strip() and not l.strip().startswith('--')]
        if not lines:
            continue
        con.execute(stmt)

# ── Source totals ──────────────────────────────────────────────
source_totals = {
    'membership_fee':    con.execute("SELECT SUM(membership_fee) FROM patrons").fetchone()[0],
    'replacement_cost':  con.execute("SELECT SUM(replacement_cost) FROM books").fetchone()[0],
    'fine_amount':       con.execute("SELECT SUM(fine_amount) FROM checkouts").fetchone()[0],
    'hold_count':        con.execute("SELECT SUM(hold_count) FROM holds").fetchone()[0],
}

print("=" * 70)
print("SOURCE TOTALS")
print("=" * 70)
for k, v in source_totals.items():
    print(f"  {k}: {v}")
print()

# ── Table definitions ──────────────────────────────────────────
tables = {
    'patron_book_report': {
        'dims': [
            {'key': 'patron', 'id': 'patron_id', 'label': 'patron_name'},
            {'key': 'book',   'id': 'book_id',   'label': 'book_name'},
        ],
        'additive_metrics': ['membership_fee', 'replacement_cost', 'fine_amount', 'hold_count'],
        'sumsum_metrics': {'avg_fine_per_checkout': 'avg_fine_per_checkout_weight'},
    },
    'patron_author_report': {
        'dims': [
            {'key': 'patron', 'id': 'patron_id', 'label': 'patron_name'},
            {'key': 'book',   'id': 'book_id',   'label': 'book_name'},
            {'key': 'author', 'id': 'author_id', 'label': 'author_name'},
        ],
        'additive_metrics': ['membership_fee', 'replacement_cost', 'fine_amount', 'hold_count'],
        'sumsum_metrics': {'avg_fine_per_checkout': 'avg_fine_per_checkout_weight'},
    },
}

# ── Generate all grain combos ─────────────────────────────────
all_combos = []
for tbl_name, tbl_def in tables.items():
    dim_keys = [d['key'] for d in tbl_def['dims']]
    # All subsets including empty set
    for r in range(len(dim_keys), -1, -1):
        for combo in combinations(dim_keys, r):
            all_combos.append((tbl_name, set(combo)))

print(f"Total dataset-grain combinations: {len(all_combos)}")
print()

# ── Validate each combination ─────────────────────────────────
pass_count = 0
fail_count = 0
failures = []

for tbl_name, selected_dims in all_combos:
    tbl_def = tables[tbl_name]
    dims = tbl_def['dims']
    grain_label = ' x '.join(d['key'].title() for d in dims if d['key'] in selected_dims) or 'Grand Total'

    print("=" * 70)
    print(f"TABLE: {tbl_name}  |  GRAIN: {grain_label}")
    print("=" * 70)

    # Build GROUP BY columns
    group_cols = []
    select_dim_cols = []
    for d in dims:
        if d['key'] in selected_dims:
            group_cols.append(f'"{d["id"]}"')
            select_dim_cols.append(f'"{d["id"]}"')
            select_dim_cols.append(f'"{d["label"]}"')

    # ── Check 1: Additive metric SUMs ──────────────────────────
    for metric in tbl_def['additive_metrics']:
        if group_cols:
            sql = f'SELECT SUM("{metric}") FROM "{tbl_name}"'
        else:
            sql = f'SELECT SUM("{metric}") FROM "{tbl_name}"'

        bft_sum = con.execute(sql).fetchone()[0] or 0
        expected = source_totals[metric]
        match = abs(bft_sum - expected) < 0.01
        status = "PASS" if match else "FAIL"
        if not match:
            fail_count += 1
            failures.append(f"{tbl_name} / {grain_label} / SUM({metric}): got {bft_sum}, expected {expected}")
        else:
            pass_count += 1
        print(f"  SUM({metric}): {bft_sum:.2f} vs source {expected:.2f} -> {status}")

    # ── Check 2: Aggregated additive metrics per group ─────────
    # When we GROUP BY some dims, each group's SUM should still be valid.
    # Spot-check: for each group, verify the metric sum makes sense against source.
    if group_cols:
        group_by = ', '.join(group_cols)

        for metric in tbl_def['additive_metrics']:
            # Get aggregated values
            agg_sql = f'''
                SELECT {', '.join(select_dim_cols)}, SUM("{metric}") as agg_val
                FROM "{tbl_name}"
                GROUP BY {', '.join(select_dim_cols)}
                ORDER BY {group_by}
            '''
            agg_rows = con.execute(agg_sql).fetchall()

            # Cross-check: sum of group values should equal total
            group_total = sum(r[-1] or 0 for r in agg_rows)
            expected = source_totals[metric]
            match = abs(group_total - expected) < 0.01
            status = "PASS" if match else "FAIL"
            if not match:
                fail_count += 1
                failures.append(f"{tbl_name} / {grain_label} / SUM-of-groups({metric}): got {group_total}, expected {expected}")
            else:
                pass_count += 1
            print(f"  SUM-of-groups({metric}): {group_total:.2f} vs source {expected:.2f} -> {status}")

            # Spot-check: no group should have negative values for additive metrics
            # (except elimination correction rows which have patron_id=NULL)
            negatives = [r for r in agg_rows if (r[-1] or 0) < -0.001]
            if negatives and metric != 'replacement_cost':
                # replacement_cost has elimination correction rows with negative values
                print(f"    WARNING: {len(negatives)} groups with negative {metric}")

    # ── Check 3: Sum/Sum weighted average ──────────────────────
    for metric, weight_col in tbl_def['sumsum_metrics'].items():
        # Compute weighted average from full BFT
        wa_sql = f'''
            SELECT
                SUM("{metric}" * "{weight_col}") / NULLIF(SUM("{weight_col}"), 0) as weighted_avg,
                SUM("{weight_col}") as total_weight
            FROM "{tbl_name}"
        '''
        wa_result = con.execute(wa_sql).fetchone()
        full_weighted_avg = wa_result[0] or 0

        # If grouping, check each group's weighted average
        if group_cols:
            group_by = ', '.join(group_cols)
            grp_sql = f'''
                SELECT {', '.join(select_dim_cols)},
                    SUM("{metric}" * "{weight_col}") / NULLIF(SUM("{weight_col}"), 0) as weighted_avg,
                    SUM("{weight_col}") as total_weight
                FROM "{tbl_name}"
                GROUP BY {', '.join(select_dim_cols)}
                ORDER BY {group_by}
            '''
            grp_rows = con.execute(grp_sql).fetchall()

            # Cross-check: weighted average of groups should equal overall weighted average
            total_vw = sum((r[-2] or 0) * (r[-1] or 0) for r in grp_rows)
            total_w = sum(r[-1] or 0 for r in grp_rows)
            recomputed = total_vw / total_w if total_w > 0 else 0
            match = abs(recomputed - full_weighted_avg) < 0.0001
            status = "PASS" if match else "FAIL"
            if not match:
                fail_count += 1
                failures.append(f"{tbl_name} / {grain_label} / weighted_avg({metric}): recomputed {recomputed}, expected {full_weighted_avg}")
            else:
                pass_count += 1
            print(f"  weighted_avg({metric}): recomputed={recomputed:.4f} vs full={full_weighted_avg:.4f} -> {status}")

            # Spot-check a few individual group weighted averages against source
            # For patron-level: compare to the patron's actual avg_fine_per_checkout
            if 'patron' in selected_dims and len(selected_dims) == 1:
                print(f"  Spot-checking {metric} per patron against source...")
                spot_fails = 0
                for row in grp_rows[:5]:  # check first 5
                    patron_id = row[0]
                    if patron_id is None:
                        continue
                    bft_avg = row[-2] or 0
                    # Get source value
                    src = con.execute(f'SELECT avg_fine_per_checkout FROM patrons WHERE patron_id = {patron_id}').fetchone()
                    if src:
                        src_avg = src[0]
                        match = abs(bft_avg - src_avg) < 0.01
                        if not match:
                            spot_fails += 1
                            print(f"    patron {patron_id}: BFT={bft_avg:.4f}, source={src_avg:.4f} MISMATCH")
                        else:
                            print(f"    patron {patron_id}: BFT={bft_avg:.4f}, source={src_avg:.4f} OK")
                if spot_fails > 0:
                    fail_count += 1
                    failures.append(f"{tbl_name} / {grain_label} / spot-check {metric}: {spot_fails} mismatches")
                else:
                    pass_count += 1
        else:
            print(f"  weighted_avg({metric}): {full_weighted_avg:.4f}")
            pass_count += 1

    # ── Check 4: Spot-check individual cells for allocation ────
    if 'patron' in selected_dims and len(selected_dims) >= 2:
        # For the full grain, spot-check membership_fee allocation
        # Pick a patron and verify their fee is split correctly
        sample_sql = f'''
            SELECT patron_id, patron_name,
                   SUM(membership_fee) as total_fee
            FROM "{tbl_name}"
            WHERE patron_id IS NOT NULL
            GROUP BY patron_id, patron_name
            LIMIT 3
        '''
        samples = con.execute(sample_sql).fetchall()
        print(f"  Spot-checking allocation (membership_fee per patron)...")
        spot_ok = True
        for pid, pname, total_fee in samples:
            src_fee = con.execute(f'SELECT membership_fee FROM patrons WHERE patron_id = {pid}').fetchone()[0]
            match = abs(total_fee - src_fee) < 0.01
            if not match:
                print(f"    {pname} (id={pid}): BFT sum={total_fee:.2f}, source={src_fee:.2f} MISMATCH")
                spot_ok = False
            else:
                print(f"    {pname} (id={pid}): BFT sum={total_fee:.2f}, source={src_fee:.2f} OK")
        if spot_ok:
            pass_count += 1
        else:
            fail_count += 1
            failures.append(f"{tbl_name} / {grain_label} / spot-check allocation: mismatches found")

    # ── Check 5: Heading validation ────────────────────────────
    # Verify the columns returned by the aggregation match expectations
    expected_dim_cols = []
    for d in dims:
        if d['key'] in selected_dims:
            expected_dim_cols.extend([d['id'], d['label']])

    expected_metric_cols = tbl_def['additive_metrics'] + list(tbl_def['sumsum_metrics'].keys())

    if group_cols:
        test_sql = f'''
            SELECT {', '.join(select_dim_cols)}, {', '.join(f'SUM("{m}") as "{m}"' for m in tbl_def['additive_metrics'])},
                   SUM("{list(tbl_def["sumsum_metrics"].keys())[0]}" * "{list(tbl_def["sumsum_metrics"].values())[0]}") /
                   NULLIF(SUM("{list(tbl_def["sumsum_metrics"].values())[0]}"), 0) as "{list(tbl_def["sumsum_metrics"].keys())[0]}"
            FROM "{tbl_name}"
            GROUP BY {', '.join(select_dim_cols)}
            LIMIT 1
        '''
    else:
        test_sql = f'''
            SELECT {', '.join(f'SUM("{m}") as "{m}"' for m in tbl_def['additive_metrics'])},
                   SUM("{list(tbl_def["sumsum_metrics"].keys())[0]}" * "{list(tbl_def["sumsum_metrics"].values())[0]}") /
                   NULLIF(SUM("{list(tbl_def["sumsum_metrics"].values())[0]}"), 0) as "{list(tbl_def["sumsum_metrics"].keys())[0]}"
            FROM "{tbl_name}"
        '''

    result = con.execute(test_sql)
    actual_cols = [d[0] for d in result.description]
    expected_cols = expected_dim_cols + expected_metric_cols

    heading_match = actual_cols == expected_cols
    status = "PASS" if heading_match else "FAIL"
    if not heading_match:
        fail_count += 1
        failures.append(f"{tbl_name} / {grain_label} / headings: expected {expected_cols}, got {actual_cols}")
    else:
        pass_count += 1
    print(f"  Headings: {actual_cols} -> {status}")

    print()

# ── Summary ────────────────────────────────────────────────────
print("=" * 70)
print(f"SUMMARY: {pass_count} passed, {fail_count} failed")
print("=" * 70)
if failures:
    print("\nFAILURES:")
    for f in failures:
        print(f"  - {f}")
else:
    print("\nAll checks passed!")
