# P5 TUI Framework

## Decision

**@clack/prompts + custom strategy matrix grid**, all in vanilla TypeScript.

### Why this approach

The wizard has four sequential steps. Three of them (data model discovery, weight definition, BFT table composition) are standard form/selection flows — text input, selects, multi-selects, confirmations. One step (strategy matrix) is a navigable grid with cell-level editing and visual feedback. These are fundamentally different interaction patterns, and the stack reflects that:

- **@clack/prompts** handles the form steps. It's MIT-licensed, actively maintained (last release Feb 2026), TypeScript/ESM-native, and small enough (~26 source files total) that we can fork and fix if needed. Each prompt is an independent async function that takes stdin, returns a value, and releases — clean handoff to the grid.

- **Custom grid renderer** handles the strategy matrix. No prompt library or framework provides a navigable grid component, so this is custom code regardless of stack choice. Building it in vanilla TS with direct ANSI output means bugs are in our code, not in an abstraction layer.

### Why not Ink

Ink (React for the terminal) was considered. It's proven technology — Claude Code uses it. But the debugging path for layout/rendering issues goes through React's reconciler → Ink's renderer → Yoga's layout engine → terminal output. When a grid cell renders one column off, the bug could be in any of those layers. Forking Ink doesn't help if the issue is in Yoga. For a sequential wizard (not a persistent full-screen app), the reactive rendering model adds abstraction depth without proportional benefit.

### Why not Enquirer

The original analysis recommended Enquirer. It hasn't been published since 2022. @clack/prompts is actively maintained, TypeScript-native, and a better fit for an ESM project.

## Implementation Status

**Code complete.** 187 tests passing (unit + tmux integration + e2e). Not yet committed.

## Architecture

### Dependencies

| Package | Purpose | Size |
|---|---|---|
| `@clack/prompts` | Text input, select, multi-select, confirm prompts | ~4KB gzip |
| `chalk` | Terminal colors (wizard output and grid) | tiny, zero-dep |
| `ansi-escapes` | Cursor positioning for grid renderer | tiny, zero-dep |
| `duckdb` | Database introspection for auto-detecting data model | native addon |

### Module structure

```
src/wizard/
├── index.ts              # Entry point, wizard runner (88 lines)
├── state.ts              # Wizard state + pure transition functions (345 lines)
├── introspect.ts         # DuckDB introspection: tables, FKs, numeric cols (413 lines)
├── steps/
│   ├── data-model.ts     # Step 1: DB-driven entity/relationship/metric discovery (460 lines)
│   ├── strategy-matrix.ts # Step 2: custom grid for propagation strategies (58 lines)
│   ├── weights.ts        # Step 3: allocation weight prompts (45 lines)
│   └── tables.ts         # Step 4: BFT table composition prompts (91 lines)
└── grid/
    ├── layout.ts         # Pure layout math: column widths, scroll, viewport (179 lines)
    ├── renderer.ts       # ANSI grid drawing (242 lines)
    └── input.ts          # Raw mode keypress handling for grid navigation (135 lines)
```

Total: ~2,056 lines source, ~1,495 lines tests.

### Key design decisions during implementation

- **Database introspection** (`introspect.ts`): The wizard auto-detects entities, relationships (via foreign keys), and candidate metrics (numeric columns) from a DuckDB database. This is the primary entry point — the user points at a database and the wizard discovers the data model rather than having the user describe it manually.

- **Grid layout separation**: Layout math (column widths, scroll offsets, viewport calculations) was extracted into `grid/layout.ts` as pure functions, keeping the renderer focused on ANSI output. This made unit testing straightforward — layout tests don't need terminal interaction.

- **DuckDB file locking**: DuckDB's native addon holds file locks even after `close()` in the same process. E2e tests work around this by creating test databases in a child process.

### Interaction model

Step 1 uses @clack/prompts for confirmation/editing of auto-detected entities, relationships, and metrics. Steps 3 and 4 also use @clack/prompts. Step 2 switches to raw stdin mode for the strategy matrix grid. The transitions are clean — clack prompts release stdin when they resolve.

### Output

The wizard produces a complete `Manifest` object (matching `src/manifest/types.ts`), then:
1. Runs it through `validate()` to catch errors
2. Serializes to YAML via `src/manifest/yaml.ts`
3. Writes to file (with `--output`) or prints to stdout

### Tests

```
test/wizard/
├── state.test.ts        # State transitions and manifest building (415 lines)
├── layout.test.ts       # Grid layout pure math (146 lines)
├── renderer.test.ts     # Renderer output capture via StringWritable (186 lines)
├── input.test.ts        # Keypress handling (35 lines)
├── grid-tmux.test.ts    # Tmux integration: grid navigation and cell cycling (192 lines)
├── wizard-e2e.test.ts   # Full wizard flow against test DuckDB (279 lines)
├── tmux-helpers.ts      # Tmux session management utilities (107 lines)
├── grid-harness.ts      # Grid test harness (77 lines)
└── create-test-db.ts    # Test database creation helper (58 lines)
```

## Remaining work

- [ ] Commit and push
- [ ] Manual testing with university dataset
- [ ] PR
