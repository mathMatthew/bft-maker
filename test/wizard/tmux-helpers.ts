/**
 * tmux helpers for integration testing interactive TUI components.
 *
 * Provides functions to:
 * - Create/destroy tmux sessions
 * - Send keystrokes
 * - Capture pane content
 * - Wait for specific text to appear
 */
import { execSync } from "node:child_process";

const SESSION_PREFIX = "bft-test-";
let sessionCounter = 0;

export interface TmuxSession {
  name: string;
}

export interface SessionOptions {
  /** Keep pane alive after command exits (needed to capture final output). */
  remainOnExit?: boolean;
  /** Terminal width. Default: 80. */
  cols?: number;
  /** Terminal height. Default: 24. */
  rows?: number;
}

/** Create a new tmux session running a command. */
export function createSession(command: string, opts: SessionOptions = {}): TmuxSession {
  const name = `${SESSION_PREFIX}${process.pid}-${sessionCounter++}`;
  const cols = opts.cols ?? 80;
  const rows = opts.rows ?? 24;
  execSync(
    `tmux new-session -d -s "${name}" -x ${cols} -y ${rows} '${command}'`,
    { stdio: "ignore" },
  );
  if (opts.remainOnExit) {
    execSync(`tmux set-option -t "${name}" remain-on-exit on`, { stdio: "ignore" });
  }
  return { name };
}

/** Kill a tmux session. */
export function killSession(session: TmuxSession): void {
  try {
    execSync(`tmux kill-session -t "${session.name}"`, { stdio: "ignore" });
  } catch {
    // Session may already be dead
  }
}

/** Send keys to the tmux session. */
export function sendKeys(session: TmuxSession, keys: string): void {
  execSync(`tmux send-keys -t "${session.name}" ${keys}`);
}

/** Send a literal string (not interpreted as tmux key names). */
export function sendText(session: TmuxSession, text: string): void {
  execSync(`tmux send-keys -t "${session.name}" -l '${text.replace(/'/g, "'\\''")}'`);
}

/** Capture the current pane content as plain text. */
export function capturePane(session: TmuxSession): string {
  return execSync(
    `tmux capture-pane -t "${session.name}" -p`,
    { encoding: "utf-8" },
  );
}

/** Sleep for ms milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait until the captured pane contains the target text,
 * or timeout after maxWaitMs.
 */
export async function waitForText(
  session: TmuxSession,
  target: string,
  maxWaitMs = 5000,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const content = capturePane(session);
    if (content.includes(target)) return content;
    await sleep(200);
  }
  const final = capturePane(session);
  throw new Error(
    `Timed out waiting for "${target}" after ${maxWaitMs}ms.\n` +
    `Last capture:\n${final}`,
  );
}

/**
 * Check if tmux is available.
 */
export function tmuxAvailable(): boolean {
  try {
    execSync("tmux -V", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
