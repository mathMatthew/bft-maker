#!/bin/bash
# Run all university reference SQL against DuckDB.
# Usage: cd <repo-root> && bash data/university/sql/run.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

echo "=== Loading data ==="
python3 -c "
import duckdb, sys

con = duckdb.connect()

# Load data
for t in ['students','classes','professors','enrollments','assignments']:
    con.execute(f\"CREATE TABLE {t} AS SELECT * FROM read_csv_auto('data/university/{t}.csv')\")
print('  Source tables loaded')

# Run each SQL file
files = ['data/university/sql/student_experience.sql', 'data/university/sql/department_financial.sql']
all_pass = True
for filepath in files:
    print(f'\n=== {filepath} ===')
    sql = open(filepath).read()
    stmts = [s.strip() for s in sql.split(';') if s.strip()]
    for stmt in stmts:
        lines = [l for l in stmt.split('\n') if l.strip() and not l.strip().startswith('--')]
        if not lines:
            continue
        result = con.execute(stmt)
        first_keyword = lines[0].strip().split()[0].upper() if lines else ''
        if first_keyword == 'SELECT':
            rows = result.fetchall()
            cols = [d[0] for d in result.description]
            for row in rows:
                d = dict(zip(cols, row))
                status = 'PASS' if 'PASS' in str(d.get('result','')) else 'FAIL'
                if status == 'FAIL':
                    all_pass = False
                print(f\"  {d['test']}: {d['result']}\")

print()
if all_pass:
    print('All validations passed.')
else:
    print('SOME VALIDATIONS FAILED')
    sys.exit(1)
"
