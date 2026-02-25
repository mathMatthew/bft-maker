-- 00_load_data.sql
-- Load university fixture CSVs into DuckDB tables.

CREATE OR REPLACE TABLE students AS
SELECT * FROM read_csv_auto('data/university/students.csv');

CREATE OR REPLACE TABLE classes AS
SELECT * FROM read_csv_auto('data/university/classes.csv');

CREATE OR REPLACE TABLE professors AS
SELECT * FROM read_csv_auto('data/university/professors.csv');

CREATE OR REPLACE TABLE enrollments AS
SELECT * FROM read_csv_auto('data/university/enrollments.csv');

CREATE OR REPLACE TABLE assignments AS
SELECT * FROM read_csv_auto('data/university/assignments.csv');
