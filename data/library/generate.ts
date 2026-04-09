/**
 * Generate synthetic library data for BFT testing.
 * Run: npx tsx data/library/generate.ts
 *
 * Domain: Public library — Patrons, Books, Authors, Checkouts, Fines, Holds.
 * Tests stock+flow coexistence, M2M (books-authors), junction metrics.
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

// --- Patrons (20) ---
const patronNames = [
  "Alice", "Bob", "Carol", "Dan", "Eve", "Frank", "Grace", "Hank",
  "Iris", "Jack", "Kate", "Leo", "Mia", "Nate", "Olive", "Pat",
  "Quinn", "Rosa", "Sam", "Tina",
];
const patrons = patronNames.map((name, i) => ({
  patron_id: i + 1,
  name,
  membership_fee: randInt(2, 10) * 10, // $20-$100
  avg_fine_per_checkout: 0, // computed below
}));

// --- Books (15) ---
const bookTitles = [
  "The Great Gatsby", "To Kill a Mockingbird", "1984", "Pride and Prejudice",
  "The Catcher in the Rye", "Brave New World", "Lord of the Flies",
  "Animal Farm", "The Hobbit", "Fahrenheit 451", "Jane Eyre",
  "Wuthering Heights", "Dune", "Neuromancer", "Foundation",
];
const books = bookTitles.map((title, i) => ({
  book_id: i + 1,
  title,
  replacement_cost: randInt(10, 40) * 100, // $10.00-$40.00 stored as cents/100
}));

// --- Authors (8) ---
const authorNames = [
  "Fitzgerald", "Lee", "Orwell", "Austen", "Salinger",
  "Huxley", "Golding", "Tolkien",
];
const authors = authorNames.map((name, i) => ({
  author_id: i + 1,
  name,
}));

// --- BookAuthor junction (~20 links, some books have 2 authors) ---
const bookAuthors: { book_id: number; author_id: number }[] = [];
const bookAuthorSet = new Set<string>();

// Every book gets at least one author
for (const b of books) {
  const a = randInt(1, authors.length);
  const key = `${b.book_id}-${a}`;
  bookAuthorSet.add(key);
  bookAuthors.push({ book_id: b.book_id, author_id: a });
}
// Add ~5 extra co-author links
for (let i = 0; i < 10; i++) {
  const b = randInt(1, books.length);
  const a = randInt(1, authors.length);
  const key = `${b}-${a}`;
  if (!bookAuthorSet.has(key)) {
    bookAuthorSet.add(key);
    bookAuthors.push({ book_id: b, author_id: a });
  }
}

// --- Checkouts (~60 links: patron × book with dates and fines) ---
const checkouts: {
  checkout_id: number;
  patron_id: number;
  book_id: number;
  checkout_date: string;
  return_date: string;
  fine_amount: number;
}[] = [];

let checkoutId = 0;
for (let i = 0; i < 60; i++) {
  const patron_id = randInt(1, patrons.length);
  const book_id = randInt(1, books.length);
  const dayOffset = randInt(0, 180);
  const checkoutDate = new Date(2024, 0, 1 + dayOffset);
  const daysOut = randInt(3, 30);
  const returnDate = new Date(checkoutDate.getTime() + daysOut * 86400000);
  // ~30% chance of a fine
  const fine_amount = rand() < 0.3 ? randInt(1, 10) * 50 : 0; // $0.50-$5.00 in cents, stored as dollars
  checkoutId++;
  checkouts.push({
    checkout_id: checkoutId,
    patron_id,
    book_id,
    checkout_date: fmt(checkoutDate),
    return_date: fmt(returnDate),
    fine_amount: fine_amount / 100,
  });
}

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Compute avg_fine_per_checkout per patron
const patronFines = new Map<number, { total: number; count: number }>();
for (const c of checkouts) {
  const entry = patronFines.get(c.patron_id) ?? { total: 0, count: 0 };
  entry.total += c.fine_amount;
  entry.count++;
  patronFines.set(c.patron_id, entry);
}
for (const p of patrons) {
  const entry = patronFines.get(p.patron_id);
  p.avg_fine_per_checkout = entry ? Math.round((entry.total / entry.count) * 100) / 100 : 0;
}

// --- Holds (~15 active: patron × book, point-in-time) ---
const holds: {
  patron_id: number;
  book_id: number;
  hold_date: string;
  hold_count: number;
}[] = [];
const holdSet = new Set<string>();

for (let i = 0; i < 25; i++) {
  const patron_id = randInt(1, patrons.length);
  const book_id = randInt(1, books.length);
  const key = `${patron_id}-${book_id}`;
  if (!holdSet.has(key)) {
    holdSet.add(key);
    const dayOffset = randInt(150, 200);
    const holdDate = new Date(2024, 0, 1 + dayOffset);
    holds.push({
      patron_id,
      book_id,
      hold_date: fmt(holdDate),
      hold_count: 1, // each hold = 1, stock metric
    });
  }
  if (holds.length >= 15) break;
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

console.log("Generating library data...");
writeCsv("patrons.csv", ["patron_id", "name", "membership_fee", "avg_fine_per_checkout"], patrons);
writeCsv("books.csv", ["book_id", "title", "replacement_cost"], books);
writeCsv("authors.csv", ["author_id", "name"], authors);
writeCsv("book_authors.csv", ["book_id", "author_id"], bookAuthors);
writeCsv("checkouts.csv", ["checkout_id", "patron_id", "book_id", "checkout_date", "return_date", "fine_amount"], checkouts);
writeCsv("holds.csv", ["patron_id", "book_id", "hold_date", "hold_count"], holds);

// Print summary
console.log(`\nSummary:`);
console.log(`  Patrons: ${patrons.length}`);
console.log(`  Books: ${books.length}`);
console.log(`  Authors: ${authors.length}`);
console.log(`  BookAuthor links: ${bookAuthors.length}`);
console.log(`  Checkouts: ${checkouts.length}`);
console.log(`  Holds: ${holds.length}`);
console.log(`  Total membership fees: $${patrons.reduce((s, x) => s + x.membership_fee, 0)}`);
console.log(`  Total replacement cost: $${books.reduce((s, x) => s + x.replacement_cost, 0)}`);
console.log(`  Total fines: $${checkouts.reduce((s, x) => s + x.fine_amount, 0).toFixed(2)}`);
