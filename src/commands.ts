import { readFile, writeFile } from "node:fs/promises";
import {
  booleanFlag,
  numberFlag,
  requiredNumberFlag,
  stringFlag,
  UsageError,
  type ParsedCommand,
} from "./args.js";
import type { ServerRequest, ServerResponse } from "./connection.js";
import { androidKeycode, buttonKeycode, metaStateFor } from "./keys.js";
import {
  activationPoint,
  AmbiguousMatchError,
  elementAt,
  selectElement,
  type Selector,
  type SelectorKind,
} from "./select.js";
import type { DeviceInfo } from "./session.js";
import {
  describeWindows,
  type AndroidWindow,
  type UiElement,
} from "./tree.js";

/** What a command needs from a device; `Session` in practice, a fake in tests. */
export interface Device {
  readonly serial: string;
  readonly info: DeviceInfo;
  request(request: ServerRequest, timeoutMs?: number): Promise<ServerResponse>;
  windows(): Promise<AndroidWindow[]>;
}

/** Defaults a long-lived `serve` or `batch` sets for every command it runs. */
export interface CommandDefaults {
  waitTimeoutSeconds?: number;
  pollIntervalSeconds?: number;
}

export interface CommandResult {
  /** What the command line prints on success. */
  message?: string;
  /** Extra fields for a `serve` response, e.g. `tree`. */
  fields?: Record<string, unknown>;
}

const DEFAULT_POLL_INTERVAL_SECONDS = 0.25;
const DEFAULT_SWIPE_SECONDS = 0.3;
const DEFAULT_SWIPE_STEP_DP = 10;
const DEFAULT_TOUCH_HOLD_SECONDS = 0.1;

export async function runCommand(
  device: Device,
  command: ParsedCommand,
  defaults: CommandDefaults = {},
): Promise<CommandResult> {
  switch (command.name) {
    case "describe-ui":
      return describeUi(device, command);
    case "tap":
      return tap(device, command, defaults);
    case "type":
      return type(device, command);
    case "swipe":
      return swipe(device, command);
    case "touch":
      return touch(device, command);
    case "key":
      return key(device, command);
    case "key-sequence":
      return keySequence(device, command);
    case "key-combo":
      return keyCombo(device, command);
    case "button":
      return button(device, command);
    case "gesture":
      return gesture(device, command);
    case "screenshot":
      return screenshot(device, command);
    default:
      throw new UsageError(`'${command.name}' can't run here.`);
  }
}

async function describeUi(
  device: Device,
  command: ParsedCommand,
): Promise<CommandResult> {
  const tree = describeWindows(await device.windows(), device.info, {
    allWindows: booleanFlag(command, "--all-windows"),
  });
  const point = stringFlag(command, "--point");
  if (point === undefined)
    return { message: JSON.stringify(tree, null, 2), fields: { tree } };

  const [x, y] = point.split(",").map(Number);
  if (
    x === undefined ||
    y === undefined ||
    !Number.isFinite(x) ||
    !Number.isFinite(y)
  ) {
    throw new UsageError(`--point must be x,y, not '${point}'.`);
  }
  const element = elementAt(tree, x, y);
  if (!element) throw new Error(`No accessibility element at ${x},${y}.`);
  return {
    message: JSON.stringify(element, null, 2),
    fields: { tree: element },
  };
}

async function tap(
  device: Device,
  command: ParsedCommand,
  defaults: CommandDefaults,
): Promise<CommandResult> {
  await delay(numberFlag(command, "--pre-delay"));
  const x = numberFlag(command, "-x");
  const y = numberFlag(command, "-y");
  let target: { x: number; y: number };
  let described: string;
  if (x !== undefined && y !== undefined) {
    target = { x, y };
    described = `(${x}, ${y})`;
  } else {
    const selector = selectorFrom(command);
    const element = await waitForElement(device, selector, {
      timeoutSeconds:
        numberFlag(command, "--wait-timeout") ??
        defaults.waitTimeoutSeconds ??
        0,
      intervalSeconds:
        numberFlag(command, "--poll-interval") ??
        defaults.pollIntervalSeconds ??
        DEFAULT_POLL_INTERVAL_SECONDS,
    });
    target = activationPoint(element, device.info);
    described = `${selector.kind} '${selector.text}' at (${target.x}, ${target.y})`;
  }
  await device.request({ cmd: "tap", x: target.x, y: target.y });
  await delay(numberFlag(command, "--post-delay"));
  return { message: `Tapped ${described}.` };
}

function selectorFrom(command: ParsedCommand): Selector {
  const elementType = stringFlag(command, "--element-type");
  for (const kind of [
    "id",
    "label",
    "value",
  ] as const satisfies readonly SelectorKind[]) {
    const text = stringFlag(command, `--${kind}`);
    if (text !== undefined)
      return { kind, text, ...(elementType && { elementType }) };
  }
  throw new UsageError(
    "tap needs -x and -y, or one of --id, --label or --value.",
  );
}

/**
 * Polls for the element until it resolves or the wait runs out. Only
 * absence (or being off screen) is worth waiting out: an ambiguous selector
 * stays ambiguous, so it fails at once.
 */
async function waitForElement(
  device: Device,
  selector: Selector,
  wait: { timeoutSeconds: number; intervalSeconds: number },
): Promise<UiElement> {
  const deadline = Date.now() + wait.timeoutSeconds * 1000;
  for (;;) {
    try {
      return selectElement(
        describeWindows(await device.windows(), device.info),
        selector,
      );
    } catch (error) {
      if (error instanceof AmbiguousMatchError || Date.now() >= deadline)
        throw error;
    }
    await delay(wait.intervalSeconds);
  }
}

async function type(
  device: Device,
  command: ParsedCommand,
): Promise<CommandResult> {
  let text = command.positionals[0];
  const file = stringFlag(command, "--file");
  if (file !== undefined) text = await readFile(file, "utf8");
  else if (booleanFlag(command, "--stdin")) text = await readStdin();
  if (text === undefined)
    throw new UsageError("type needs text, --stdin or --file.");
  // A newline is the Return key, as on a keyboard: it submits a search or
  // moves on, where inserting it as text would do nothing in a single-line
  // field.
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (const [index, line] of lines.entries()) {
    if (index > 0) await pressKey(device, KEYCODE_ENTER, 0);
    if (line !== "") await device.request({ cmd: "text", text: line });
  }
  return { message: `Typed ${text.length} characters.` };
}

const KEYCODE_ENTER = androidKeycode("ENTER");

async function swipe(
  device: Device,
  command: ParsedCommand,
): Promise<CommandResult> {
  await delay(numberFlag(command, "--pre-delay"));
  await swipeBetween(
    device,
    {
      startX: requiredNumberFlag(command, "--start-x"),
      startY: requiredNumberFlag(command, "--start-y"),
      endX: requiredNumberFlag(command, "--end-x"),
      endY: requiredNumberFlag(command, "--end-y"),
    },
    numberFlag(command, "--duration"),
    numberFlag(command, "--delta"),
  );
  await delay(numberFlag(command, "--post-delay"));
  return { message: "Swiped." };
}

interface SwipePath {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

async function swipeBetween(
  device: Device,
  path: SwipePath,
  durationSeconds = DEFAULT_SWIPE_SECONDS,
  stepDp = DEFAULT_SWIPE_STEP_DP,
): Promise<void> {
  const durationMs = Math.round(durationSeconds * 1000);
  await device.request(
    { cmd: "swipe", ...path, durationMs, stepDp },
    durationMs + 30_000,
  );
}

async function touch(
  device: Device,
  command: ParsedCommand,
): Promise<CommandResult> {
  const x = requiredNumberFlag(command, "-x");
  const y = requiredNumberFlag(command, "-y");
  const down = booleanFlag(command, "--down");
  const up = booleanFlag(command, "--up");
  if (!down && !up) throw new UsageError("touch needs --down, --up or both.");
  if (down) await device.request({ cmd: "touch-down", x, y });
  if (down && up)
    await delay(numberFlag(command, "--delay") ?? DEFAULT_TOUCH_HOLD_SECONDS);
  if (up) await device.request({ cmd: "touch-up", x, y });
  return {
    message: `Touched ${[down && "down", up && "up"].filter(Boolean).join(" and ")} at (${x}, ${y}).`,
  };
}

async function key(
  device: Device,
  command: ParsedCommand,
): Promise<CommandResult> {
  const name = command.positionals[0];
  if (name === undefined) throw new UsageError("key needs a keycode.");
  await pressKey(
    device,
    androidKeycode(name),
    0,
    numberFlag(command, "--duration"),
  );
  return { message: `Pressed key ${name}.` };
}

async function keySequence(
  device: Device,
  command: ParsedCommand,
): Promise<CommandResult> {
  const keycodes = stringFlag(command, "--keycodes");
  if (!keycodes) throw new UsageError("key-sequence needs --keycodes.");
  const keys = splitList(keycodes);
  const pause = numberFlag(command, "--delay") ?? 0.1;
  for (const [index, name] of keys.entries()) {
    if (index > 0) await delay(pause);
    await pressKey(device, androidKeycode(name), 0);
  }
  return { message: `Pressed ${keys.length} keys.` };
}

async function keyCombo(
  device: Device,
  command: ParsedCommand,
): Promise<CommandResult> {
  const modifiers = stringFlag(command, "--modifiers");
  const keyName = stringFlag(command, "--key");
  if (!modifiers || keyName === undefined)
    throw new UsageError("key-combo needs --modifiers and --key.");
  await pressKey(
    device,
    androidKeycode(keyName),
    metaStateFor(splitList(modifiers)),
  );
  return { message: `Pressed ${modifiers}+${keyName}.` };
}

async function button(
  device: Device,
  command: ParsedCommand,
): Promise<CommandResult> {
  const name = command.positionals[0];
  if (name === undefined) throw new UsageError("button needs a button name.");
  await pressKey(
    device,
    buttonKeycode(name),
    0,
    numberFlag(command, "--duration"),
  );
  return { message: `Pressed ${name}.` };
}

async function pressKey(
  device: Device,
  keycode: number,
  metaState: number,
  holdSeconds?: number,
): Promise<void> {
  const holdMs = Math.round((holdSeconds ?? 0) * 1000);
  await device.request(
    { cmd: "key", keycode, metaState, holdMs },
    holdMs + 30_000,
  );
}

/**
 * Preset gestures. Directions name where the finger moves: scroll-up
 * drags upward, bringing content further down the page into view. Edge
 * swipes start a few dp inside the edge, where Android's system gestures
 * (back, notifications) take them.
 */
async function gesture(
  device: Device,
  command: ParsedCommand,
): Promise<CommandResult> {
  const preset = command.positionals[0];
  if (preset === undefined) throw new UsageError("gesture needs a preset.");
  const width = numberFlag(command, "--screen-width") ?? device.info.widthDp;
  const height = numberFlag(command, "--screen-height") ?? device.info.heightDp;
  const midX = width / 2;
  const midY = height / 2;
  const edge = 2;
  const paths: Record<string, SwipePath> = {
    "scroll-up": {
      startX: midX,
      startY: height * 0.7,
      endX: midX,
      endY: height * 0.3,
    },
    "scroll-down": {
      startX: midX,
      startY: height * 0.3,
      endX: midX,
      endY: height * 0.7,
    },
    "scroll-left": {
      startX: width * 0.8,
      startY: midY,
      endX: width * 0.2,
      endY: midY,
    },
    "scroll-right": {
      startX: width * 0.2,
      startY: midY,
      endX: width * 0.8,
      endY: midY,
    },
    "swipe-from-left-edge": {
      startX: edge,
      startY: midY,
      endX: width * 0.6,
      endY: midY,
    },
    "swipe-from-right-edge": {
      startX: width - edge,
      startY: midY,
      endX: width * 0.4,
      endY: midY,
    },
    "swipe-from-top-edge": {
      startX: midX,
      startY: edge,
      endX: midX,
      endY: height * 0.6,
    },
    "swipe-from-bottom-edge": {
      startX: midX,
      startY: height - edge,
      endX: midX,
      endY: height * 0.4,
    },
  };
  const path = paths[preset];
  if (!path)
    throw new UsageError(
      `Unknown gesture '${preset}'. Use one of: ${Object.keys(paths).join(", ")}.`,
    );
  await delay(numberFlag(command, "--pre-delay"));
  await swipeBetween(
    device,
    path,
    numberFlag(command, "--duration"),
    numberFlag(command, "--delta"),
  );
  await delay(numberFlag(command, "--post-delay"));
  return { message: `Performed ${preset}.` };
}

async function screenshot(
  device: Device,
  command: ParsedCommand,
): Promise<CommandResult> {
  const output =
    stringFlag(command, "--output") ??
    `Emulator Screenshot - ${device.serial} - ${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
  const response = await device.request({ cmd: "screenshot" }, 60_000);
  await writeFile(output, Buffer.from(String(response.png), "base64"));
  return { message: output, fields: { path: output } };
}

const splitList = (list: string): string[] =>
  list
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const delay = (seconds: number | undefined): Promise<void> =>
  seconds && seconds > 0
    ? new Promise((resolve) => setTimeout(resolve, seconds * 1000))
    : Promise.resolve();

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
