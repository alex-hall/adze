/**
 * Argument parsing shared by the command line and `serve`, so a command
 * means the same thing in both.
 */

export interface ParsedCommand {
  name: string;
  positionals: string[];
  flags: Map<string, string | true>;
}

interface CommandSpec {
  /** Flags that take a value. */
  values: readonly string[];
  /** Flags that stand alone. */
  booleans: readonly string[];
  /** How many positional arguments the command takes at most. */
  positionals: number;
}

/** Every command takes these. `--udid` is another name for `--serial`. */
const COMMON_VALUES = ["--serial", "--udid"];
const COMMON_BOOLEANS = ["--verbose"];

const SELECTOR_FLAGS = ["--id", "--label", "--value", "--element-type"];
const WAIT_FLAGS = ["--wait-timeout", "--poll-interval"];
const DELAY_FLAGS = ["--pre-delay", "--post-delay"];

export const COMMANDS: Record<string, CommandSpec> = {
  "describe-ui": {
    values: ["--point"],
    booleans: ["--all-windows"],
    positionals: 0,
  },
  tap: {
    values: [
      "-x",
      "-y",
      ...SELECTOR_FLAGS,
      ...WAIT_FLAGS,
      ...DELAY_FLAGS,
      "--tap-style",
    ],
    booleans: [],
    positionals: 0,
  },
  type: { values: ["--file"], booleans: ["--stdin"], positionals: 1 },
  swipe: {
    values: [
      "--start-x",
      "--start-y",
      "--end-x",
      "--end-y",
      "--duration",
      "--delta",
      ...DELAY_FLAGS,
    ],
    booleans: [],
    positionals: 0,
  },
  touch: {
    values: ["-x", "-y", "--delay"],
    booleans: ["--down", "--up"],
    positionals: 0,
  },
  key: { values: ["--duration"], booleans: [], positionals: 1 },
  "key-sequence": {
    values: ["--keycodes", "--delay"],
    booleans: [],
    positionals: 0,
  },
  "key-combo": {
    values: ["--modifiers", "--key"],
    booleans: [],
    positionals: 0,
  },
  button: { values: ["--duration"], booleans: [], positionals: 1 },
  gesture: {
    values: [
      "--screen-width",
      "--screen-height",
      "--duration",
      "--delta",
      ...DELAY_FLAGS,
    ],
    booleans: [],
    positionals: 1,
  },
  screenshot: { values: ["--output"], booleans: [], positionals: 0 },
  "list-devices": { values: [], booleans: [], positionals: 0 },
  "list-simulators": { values: [], booleans: [], positionals: 0 },
  serve: {
    values: [
      ...WAIT_FLAGS,
      "--tap-style",
      "--type-submission",
      "--type-chunk-size",
    ],
    booleans: ["--minimal-keys"],
    positionals: 0,
  },
  batch: {
    values: ["--step", "--file", ...WAIT_FLAGS, "--tap-style", "--ax-cache"],
    booleans: ["--stdin", "--continue-on-error"],
    positionals: 0,
  },
};

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** Parses one command's arguments: `tap --label "Sign in" --serial emulator-5554`. */
export function parseCommand(tokens: readonly string[]): ParsedCommand {
  const [name, ...rest] = tokens;
  if (!name) throw new UsageError("No command given.");
  const spec = COMMANDS[name];
  if (!spec) throw new UsageError(`Unknown command '${name}'.`);

  const values = new Set([...spec.values, ...COMMON_VALUES]);
  const booleans = new Set([...spec.booleans, ...COMMON_BOOLEANS]);
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  // `--step` repeats in batch; every other flag keeps its last value.
  const steps: string[] = [];

  for (let index = 0; index < rest.length; index++) {
    const token = rest[index]!;
    const [flag, inline] = splitInlineValue(token);
    if (values.has(flag)) {
      const value = inline ?? rest[++index];
      if (value === undefined) throw new UsageError(`${flag} needs a value.`);
      if (flag === "--step") steps.push(value);
      else flags.set(flag, value);
    } else if (booleans.has(flag) && inline === undefined) {
      flags.set(flag, true);
    } else if (isFlag(token)) {
      throw new UsageError(`Unknown option '${token}' for ${name}.`);
    } else {
      positionals.push(token);
    }
  }
  if (positionals.length > spec.positionals) {
    throw new UsageError(
      `Unexpected argument '${positionals[spec.positionals]}' for ${name}.`,
    );
  }
  if (steps.length > 0) flags.set("--step", JSON.stringify(steps));
  // One name for the device from here on.
  const udid = flags.get("--udid");
  if (udid !== undefined && !flags.has("--serial")) flags.set("--serial", udid);
  flags.delete("--udid");
  return { name, positionals, flags };
}

/** `--duration=0.5` as well as `--duration 0.5`. */
function splitInlineValue(token: string): [string, string | undefined] {
  if (!token.startsWith("--")) return [token, undefined];
  const equals = token.indexOf("=");
  return equals === -1
    ? [token, undefined]
    : [token.slice(0, equals), token.slice(equals + 1)];
}

/** A flag, as opposed to a positional — negative numbers are positionals. */
const isFlag = (token: string): boolean => /^-{1,2}[a-zA-Z]/.test(token);

export function stringFlag(
  command: ParsedCommand,
  flag: string,
): string | undefined {
  const value = command.flags.get(flag);
  return typeof value === "string" ? value : undefined;
}

export function numberFlag(
  command: ParsedCommand,
  flag: string,
): number | undefined {
  const value = stringFlag(command, flag);
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number))
    throw new UsageError(`${flag} must be a number, not '${value}'.`);
  return number;
}

export function requiredNumberFlag(
  command: ParsedCommand,
  flag: string,
): number {
  const number = numberFlag(command, flag);
  if (number === undefined)
    throw new UsageError(`${command.name} needs ${flag}.`);
  return number;
}

export const booleanFlag = (command: ParsedCommand, flag: string): boolean =>
  command.flags.get(flag) === true;

/**
 * Splits one `serve`/`batch` line into tokens:
 * whitespace separates, double quotes group, and a backslash escapes the
 * next character inside quotes.
 */
export function tokenizeLine(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inToken = false;
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (quoted) {
      if (char === "\\" && index + 1 < line.length) {
        current += line[++index];
      } else if (char === '"') {
        quoted = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
      inToken = true;
    } else if (/\s/.test(char)) {
      if (inToken) tokens.push(current);
      current = "";
      inToken = false;
    } else {
      current += char;
      inToken = true;
    }
  }
  if (quoted) throw new UsageError("Unterminated quote.");
  if (inToken) tokens.push(current);
  return tokens;
}
