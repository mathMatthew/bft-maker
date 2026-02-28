#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Downloading Northwind CSVs ==="
mkdir -p "$SCRIPT_DIR/northwind"
BASE_URL="https://raw.githubusercontent.com/graphql-compose/graphql-compose-examples/master/examples/northwind/data/csv"
for file in categories customers employees employee_territories orders order_details products regions shippers suppliers territories; do
  echo "  $file.csv"
  curl -sL "$BASE_URL/$file.csv" -o "$SCRIPT_DIR/northwind/$file.csv"
done
echo "  Done. $(wc -l "$SCRIPT_DIR/northwind/"*.csv | tail -1 | awk '{print $1}') total lines."


echo ""
echo "All datasets downloaded."
