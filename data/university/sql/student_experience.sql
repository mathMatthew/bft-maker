-- student_experience.sql
-- BFT table: Student x Class
-- Metrics:
--   tuition_paid    (Student)  allocation via Enrollment to Class
--   satisfaction_score (Student) sum_over_sum via Enrollment to Class
--   class_budget    (Class)    elimination via Enrollment to Student
--
-- Expected rows: 100 (90 base + 10 elimination correction)
-- Expected SUMs: tuition_paid = 379000, class_budget = 345000

-----------------------------------------------------------------------
-- Step 1: Base grain (Student x Class via Enrollment)
-----------------------------------------------------------------------
CREATE OR REPLACE TABLE se_base AS
SELECT
    s.student_id,
    s.name       AS student_name,
    s.tuition_paid,
    s.satisfaction_score,
    c.class_id,
    c.name       AS class_name,
    c.class_budget
FROM students s
JOIN enrollments e ON s.student_id = e.student_id
JOIN classes c     ON c.class_id   = e.class_id;

-----------------------------------------------------------------------
-- Step 2: Compute enrollment counts (allocation/sum-over-sum weight)
-----------------------------------------------------------------------
CREATE OR REPLACE TABLE se_weighted AS
SELECT
    *,
    COUNT(*) OVER (PARTITION BY student_id) AS enrollment_count
FROM se_base;

-----------------------------------------------------------------------
-- Step 3: Apply strategies and add correction rows
-----------------------------------------------------------------------
CREATE OR REPLACE TABLE student_experience AS

-- Regular rows (one per enrollment)
SELECT
    student_id,
    student_name,
    class_id,
    class_name,
    -- Allocation: split tuition evenly across enrolled classes
    tuition_paid * 1.0 / enrollment_count           AS tuition_paid,
    -- Sum/Sum: raw value preserved
    satisfaction_score,
    -- Sum/Sum: companion weight (sums to 1.0 per student)
    1.0 / enrollment_count                           AS satisfaction_weight,
    -- Elimination: full class_budget on every row
    class_budget * 1.0                               AS class_budget
FROM se_weighted

UNION ALL

-- Elimination correction rows for class_budget
-- One per class. Student = '<Unallocated>'.
-- Offset so SUM(class_budget) = true total.
SELECT
    NULL                   AS student_id,
    '<Unallocated>'        AS student_name,
    class_id,
    class_name,
    0                      AS tuition_paid,
    0                      AS satisfaction_score,
    0                      AS satisfaction_weight,
    -- correction = value * (1 - N) where N = students enrolled in this class
    class_budget * (1 - COUNT(*)) AS class_budget
FROM se_base
GROUP BY class_id, class_name, class_budget;

-----------------------------------------------------------------------
-- Validation
-----------------------------------------------------------------------

-- V1: Row count
SELECT 'V1 row_count' AS test,
       CASE WHEN COUNT(*) = 100 THEN 'PASS' ELSE 'FAIL: ' || COUNT(*) END AS result
FROM student_experience;

-- V2: SUM(tuition_paid) = 379000
SELECT 'V2 tuition_sum' AS test,
       CASE WHEN ABS(SUM(tuition_paid) - 379000) < 0.01 THEN 'PASS'
            ELSE 'FAIL: ' || SUM(tuition_paid) END AS result
FROM student_experience;

-- V3: SUM(class_budget) = 345000
SELECT 'V3 class_budget_sum' AS test,
       CASE WHEN ABS(SUM(class_budget) - 345000) < 0.01 THEN 'PASS'
            ELSE 'FAIL: ' || SUM(class_budget) END AS result
FROM student_experience;

-- V4: Satisfaction weights sum to 1.0 per student (exclude placeholder rows)
SELECT 'V4 satisfaction_weights' AS test,
       CASE WHEN COUNT(*) = 0 THEN 'PASS'
            ELSE 'FAIL: ' || COUNT(*) || ' students with bad weights' END AS result
FROM (
    SELECT student_id, ABS(SUM(satisfaction_weight) - 1.0) AS err
    FROM student_experience
    WHERE student_id IS NOT NULL
    GROUP BY student_id
    HAVING ABS(SUM(satisfaction_weight) - 1.0) > 0.001
);

-- V5: Tuition is zero on correction rows
SELECT 'V5 tuition_on_corrections' AS test,
       CASE WHEN SUM(ABS(tuition_paid)) = 0 THEN 'PASS'
            ELSE 'FAIL: non-zero tuition on correction rows' END AS result
FROM student_experience
WHERE student_id IS NULL;

-- V6: Each class's elimination rows sum to the original class_budget
SELECT 'V6 elim_per_class' AS test,
       CASE WHEN COUNT(*) = 0 THEN 'PASS'
            ELSE 'FAIL: ' || COUNT(*) || ' classes with wrong budget sum' END AS result
FROM (
    SELECT class_id, ABS(SUM(class_budget) - MAX(cb_original)) AS err
    FROM (
        SELECT se.class_id, se.class_budget,
               c.class_budget AS cb_original
        FROM student_experience se
        JOIN classes c ON se.class_id = c.class_id
    )
    GROUP BY class_id
    HAVING ABS(SUM(class_budget) - MAX(cb_original)) > 0.01
);
