-- department_financial.sql
-- BFT table: Student x Class x Professor
-- Metrics:
--   tuition_paid  (Student)    multi-hop allocation: Enrollment -> Class, Assignment -> Professor
--   class_budget  (Class)      elimination via Enrollment to Student, reserve for Professor
--   salary        (Professor)  reserve for both Student and Class
--
-- Row breakdown:
--   113  base grain rows (student x class x professor via enrollment + assignment)
--    90  class_budget elimination data rows (Prof = '<Unallocated>')
--    10  class_budget elimination correction rows (Student + Prof = '<Unallocated>')
--     5  salary reserve rows (Student + Class = '<Unallocated>')
--   ---
--   218  total
--
-- Expected SUMs: tuition_paid = 379000, class_budget = 345000, salary = 370000

-----------------------------------------------------------------------
-- Step 1: Base grain (Student x Class x Professor)
-----------------------------------------------------------------------
CREATE OR REPLACE TABLE df_base AS
SELECT
    s.student_id,
    s.name       AS student_name,
    s.tuition_paid,
    c.class_id,
    c.name       AS class_name,
    c.class_budget,
    p.professor_id,
    p.name       AS professor_name,
    p.salary
FROM students s
JOIN enrollments e ON s.student_id = e.student_id
JOIN classes c     ON c.class_id   = e.class_id
JOIN assignments a ON c.class_id   = a.class_id
JOIN professors p  ON p.professor_id = a.professor_id;

-----------------------------------------------------------------------
-- Step 2: Multi-hop allocation weights for tuition_paid
--   Hop 1: enrollment_count = distinct classes per student
--   Hop 2: assignment_count = professors per (student, class) pair
-----------------------------------------------------------------------
CREATE OR REPLACE TABLE df_weighted AS
SELECT
    *,
    COUNT(DISTINCT class_id) OVER (PARTITION BY student_id) AS enrollment_count,
    COUNT(*) OVER (PARTITION BY student_id, class_id)       AS assignment_count
FROM df_base;

-----------------------------------------------------------------------
-- Step 3: Assemble final table
-----------------------------------------------------------------------
CREATE OR REPLACE TABLE department_financial AS

-- A) Base grain rows: tuition allocated, class_budget = 0, salary = 0
SELECT
    student_id,
    student_name,
    class_id,
    class_name,
    professor_id,
    professor_name,
    -- Multi-hop allocation: tuition / enrollment_count / assignment_count
    tuition_paid * 1.0 / enrollment_count / assignment_count AS tuition_paid,
    -- Elimination + reserve: class_budget is zero on real-professor rows
    0.0 AS class_budget,
    -- Reserve: salary is zero on regular rows
    0.0 AS salary
FROM df_weighted

UNION ALL

-- B) class_budget elimination data rows (Prof = '<Unallocated>')
--    Full class_budget on each (student, class) enrollment pair
SELECT
    student_id,
    student_name,
    class_id,
    class_name,
    NULL              AS professor_id,
    '<Unallocated>'   AS professor_name,
    0.0               AS tuition_paid,
    class_budget * 1.0 AS class_budget,
    0.0               AS salary
FROM (
    -- Deduplicate to one row per (student, class) from enrollments
    SELECT DISTINCT
        s.student_id,
        s.name       AS student_name,
        c.class_id,
        c.name       AS class_name,
        c.class_budget
    FROM students s
    JOIN enrollments e ON s.student_id = e.student_id
    JOIN classes c     ON c.class_id   = e.class_id
)

UNION ALL

-- C) class_budget elimination correction rows (Student + Prof = '<Unallocated>')
--    One per class. Offset so SUM(class_budget) = true total.
SELECT
    NULL              AS student_id,
    '<Unallocated>'   AS student_name,
    c.class_id,
    c.name            AS class_name,
    NULL              AS professor_id,
    '<Unallocated>'   AS professor_name,
    0.0               AS tuition_paid,
    -- correction = value * (1 - enrollment_count_for_class)
    c.class_budget * (1 - ec.enrollment_count) AS class_budget,
    0.0               AS salary
FROM classes c
JOIN (
    SELECT class_id, COUNT(*) AS enrollment_count
    FROM enrollments
    GROUP BY class_id
) ec ON c.class_id = ec.class_id

UNION ALL

-- D) salary reserve rows (Student + Class = '<Unallocated>')
--    One per professor.
SELECT
    NULL              AS student_id,
    '<Unallocated>'   AS student_name,
    NULL              AS class_id,
    '<Unallocated>'   AS class_name,
    professor_id,
    name              AS professor_name,
    0.0               AS tuition_paid,
    0.0               AS class_budget,
    salary * 1.0      AS salary
FROM professors;

-----------------------------------------------------------------------
-- Validation
-----------------------------------------------------------------------

-- V1: Row count = 218
SELECT 'V1 row_count' AS test,
       CASE WHEN COUNT(*) = 218 THEN 'PASS' ELSE 'FAIL: ' || COUNT(*) END AS result
FROM department_financial;

-- V2: SUM(tuition_paid) = 379000
SELECT 'V2 tuition_sum' AS test,
       CASE WHEN ABS(SUM(tuition_paid) - 379000) < 0.01 THEN 'PASS'
            ELSE 'FAIL: ' || SUM(tuition_paid) END AS result
FROM department_financial;

-- V3: SUM(class_budget) = 345000
SELECT 'V3 class_budget_sum' AS test,
       CASE WHEN ABS(SUM(class_budget) - 345000) < 0.01 THEN 'PASS'
            ELSE 'FAIL: ' || SUM(class_budget) END AS result
FROM department_financial;

-- V4: SUM(salary) = 370000
SELECT 'V4 salary_sum' AS test,
       CASE WHEN ABS(SUM(salary) - 370000) < 0.01 THEN 'PASS'
            ELSE 'FAIL: ' || SUM(salary) END AS result
FROM department_financial;

-- V5: Tuition per student sums to original tuition
SELECT 'V5 tuition_per_student' AS test,
       CASE WHEN COUNT(*) = 0 THEN 'PASS'
            ELSE 'FAIL: ' || COUNT(*) || ' students with wrong tuition sum' END AS result
FROM (
    SELECT df.student_id,
           ABS(SUM(df.tuition_paid) - s.tuition_paid) AS err
    FROM department_financial df
    JOIN students s ON df.student_id = s.student_id
    GROUP BY df.student_id, s.tuition_paid
    HAVING ABS(SUM(df.tuition_paid) - s.tuition_paid) > 0.01
);

-- V6: class_budget is zero on all real-professor rows
SELECT 'V6 budget_zero_on_prof_rows' AS test,
       CASE WHEN SUM(ABS(class_budget)) = 0 THEN 'PASS'
            ELSE 'FAIL: non-zero class_budget on professor rows' END AS result
FROM department_financial
WHERE professor_id IS NOT NULL;

-- V7: salary is zero on all non-reserve rows
SELECT 'V7 salary_zero_on_non_reserve' AS test,
       CASE WHEN SUM(ABS(salary)) = 0 THEN 'PASS'
            ELSE 'FAIL: non-zero salary on non-reserve rows' END AS result
FROM department_financial
WHERE student_name != '<Unallocated>' OR class_name != '<Unallocated>';

-- V8: Each class's class_budget rows sum to original budget
SELECT 'V8 budget_per_class' AS test,
       CASE WHEN COUNT(*) = 0 THEN 'PASS'
            ELSE 'FAIL: ' || COUNT(*) || ' classes with wrong budget sum' END AS result
FROM (
    SELECT df.class_id, ABS(SUM(df.class_budget) - c.class_budget) AS err
    FROM department_financial df
    JOIN classes c ON df.class_id = c.class_id
    GROUP BY df.class_id, c.class_budget
    HAVING ABS(SUM(df.class_budget) - c.class_budget) > 0.01
);

-- V9: Each professor's salary appears exactly once (on their reserve row)
SELECT 'V9 salary_per_professor' AS test,
       CASE WHEN COUNT(*) = 0 THEN 'PASS'
            ELSE 'FAIL: ' || COUNT(*) || ' professors with wrong salary' END AS result
FROM (
    SELECT df.professor_id, ABS(SUM(df.salary) - p.salary) AS err
    FROM department_financial df
    JOIN professors p ON df.professor_id = p.professor_id
    GROUP BY df.professor_id, p.salary
    HAVING ABS(SUM(df.salary) - p.salary) > 0.01
);
