/**
 * Generate synthetic university data for BFT testing.
 * Run: npx tsx data/university/generate.ts
 * Or: tsc && node dist/data/university/generate.js
 *
 * Produces small, deterministic CSVs that are easy to reason about.
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
function pick<T>(arr: T[]): T {
  return arr[Math.floor(rand() * arr.length)];
}

// --- Students (30) ---
const firstNames = [
  "Alice", "Bob", "Carol", "Dan", "Eve", "Frank", "Grace", "Hank",
  "Iris", "Jack", "Kate", "Leo", "Mia", "Nate", "Olive", "Pat",
  "Quinn", "Rosa", "Sam", "Tina", "Uma", "Vic", "Wendy", "Xander",
  "Yara", "Zach", "Amy", "Ben", "Chloe", "Derek",
];
const students = firstNames.map((name, i) => ({
  student_id: i + 1,
  name,
  tuition_paid: randInt(5, 20) * 1000,
  satisfaction_score: (randInt(20, 50) / 10), // 2.0 - 5.0
}));

// --- Classes (10) ---
const classNames = [
  "Intro to CS", "Calculus I", "Physics 101", "English Comp",
  "Organic Chem", "Data Structures", "Linear Algebra", "Statistics",
  "World History", "Econ 101",
];
const classes = classNames.map((name, i) => ({
  class_id: i + 1,
  name,
  class_budget: randInt(10, 50) * 1000,
}));

// --- Professors (5) ---
const profNames = ["Dr. Smith", "Dr. Jones", "Dr. Park", "Dr. Chen", "Dr. Adams"];
const professors = profNames.map((name, i) => ({
  professor_id: i + 1,
  name,
  salary: randInt(60, 120) * 1000,
}));

// --- Enrollments (~90: each student in 3 classes) ---
const enrollments: { student_id: number; class_id: number }[] = [];
const enrollmentSet = new Set<string>();
for (const s of students) {
  // Each student enrolls in exactly 3 distinct classes
  const taken = new Set<number>();
  while (taken.size < 3) {
    const c = randInt(1, classes.length);
    if (!taken.has(c)) {
      taken.add(c);
      const key = `${s.student_id}-${c}`;
      if (!enrollmentSet.has(key)) {
        enrollmentSet.add(key);
        enrollments.push({ student_id: s.student_id, class_id: c });
      }
    }
  }
}

// --- Assignments (~15: each class has 1-2 professors) ---
const assignments: { class_id: number; professor_id: number }[] = [];
const assignmentSet = new Set<string>();
for (const c of classes) {
  const numProfs = randInt(1, 2);
  const assigned = new Set<number>();
  while (assigned.size < numProfs) {
    const p = randInt(1, professors.length);
    if (!assigned.has(p)) {
      assigned.add(p);
      const key = `${c.class_id}-${p}`;
      if (!assignmentSet.has(key)) {
        assignmentSet.add(key);
        assignments.push({ class_id: c.class_id, professor_id: p });
      }
    }
  }
}

// --- Write CSVs ---
function writeCsv(filename: string, headers: string[], rows: Record<string, unknown>[]) {
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => row[h]).join(","));
  }
  const filepath = path.join(DIR, filename);
  fs.writeFileSync(filepath, lines.join("\n") + "\n");
  console.log(`  ${filename}: ${rows.length} rows`);
}

console.log("Generating university data...");
writeCsv("students.csv", ["student_id", "name", "tuition_paid", "satisfaction_score"], students);
writeCsv("classes.csv", ["class_id", "name", "class_budget"], classes);
writeCsv("professors.csv", ["professor_id", "name", "salary"], professors);
writeCsv("enrollments.csv", ["student_id", "class_id"], enrollments);
writeCsv("assignments.csv", ["class_id", "professor_id"], assignments);

// Print summary
console.log(`\nSummary:`);
console.log(`  Students: ${students.length}`);
console.log(`  Classes: ${classes.length}`);
console.log(`  Professors: ${professors.length}`);
console.log(`  Enrollments: ${enrollments.length} (avg ${(enrollments.length / students.length).toFixed(1)} per student)`);
console.log(`  Assignments: ${assignments.length} (avg ${(assignments.length / classes.length).toFixed(1)} per class)`);
console.log(`  BFT rows (S×C×P): ${enrollments.length} × ${assignments.length}/${classes.length} = ~${Math.round(enrollments.length * assignments.length / classes.length)}`);
console.log(`  Total tuition: $${students.reduce((s, x) => s + x.tuition_paid, 0).toLocaleString()}`);
console.log(`  Total salary: $${professors.reduce((s, x) => s + x.salary, 0).toLocaleString()}`);
console.log(`  Total class budget: $${classes.reduce((s, x) => s + x.class_budget, 0).toLocaleString()}`);
