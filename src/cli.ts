#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { adbBinary, listDevices, type AdbDevice } from "./adb.js";
import {
  booleanFlag,
  numberFlag,
  parseCommand,
  stringFlag,
  UsageError,
  type ParsedCommand,
} from "./args.js";
import { runCommand, type CommandDefaults } from "./commands.js";
import { LineRunner, serve } from "./serve.js";
import { Session, VERSION } from "./session.js";
import { execFile } from "node:child_process";

const USAGE = `adze ${VERSION} — drive Android emulators through accessibility.

USAGE: adze <subcommand> [--serial <serial>] [options]

  describe-ui     The accessibility tree of the screen, as JSON.
  tap             Tap a point (-x/-y) or an element (--id, --label, --value).
  type            Type text into the focused text field.
  swipe           Swipe between two points.
  touch           Touch down and/or up at a point.
  key             Press a key (HID usage code, or an Android keycode name).
  key-sequence    Press several keys in turn.
  key-combo       Press a key while holding modifiers.
  button          Press a hardware button (home, back, recents, lock, volume-up, volume-down).
  gesture         Perform a preset gesture (scroll-up, swipe-from-left-edge, ...).
  screenshot      Save a PNG of the screen.
  list-devices    List connected devices (also: list-simulators).
  batch           Run several commands over one connection.
  serve           Run commands from stdin, one JSON response per line.

Coordinates are in dp. --udid is accepted as another name for --serial.
`;

// Whoever reads our output may stop early (`adze describe-ui | head`). That
// is their choice, not a failure: stop quietly instead of throwing EPIPE.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

async function main(argv: string[]): Promise<number> {
  if (
    argv.length === 0 ||
    argv[0] === "--help" ||
    argv[0] === "-h" ||
    argv[0] === "help"
  ) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (argv[0] === "--version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  const command = parseCommand(argv);
  const verbose = booleanFlag(command, "--verbose");
  const log = verbose
    ? (message: string) => process.stderr.write(`${message}\n`)
    : undefined;
  const serial = stringFlag(command, "--serial");
  const open = () =>
    Session.open({ ...(serial && { serial }), ...(log && { log }) });

  switch (command.name) {
    case "list-devices":
    case "list-simulators":
      return printDevices();
    case "serve": {
      const runner = new LineRunner(open, defaultsFrom(command));
      await serve(runner, process.stdin, (line) =>
        process.stdout.write(`${line}\n`),
      );
      return 0;
    }
    case "batch":
      return batch(command, new LineRunner(open, defaultsFrom(command)));
    default: {
      const session = await open();
      try {
        const result = await runCommand(session, command);
        if (result.message) process.stdout.write(`${result.message}\n`);
        return 0;
      } finally {
        session.close();
      }
    }
  }
}

function defaultsFrom(command: ParsedCommand): CommandDefaults {
  const waitTimeoutSeconds = numberFlag(command, "--wait-timeout");
  const pollIntervalSeconds = numberFlag(command, "--poll-interval");
  return {
    ...(waitTimeoutSeconds !== undefined && { waitTimeoutSeconds }),
    ...(pollIntervalSeconds !== undefined && { pollIntervalSeconds }),
  };
}

/** Runs `--step`s, then `--file` or stdin lines, in order; stops at the first failure unless told not to. */
async function batch(
  command: ParsedCommand,
  runner: LineRunner,
): Promise<number> {
  const steps: string[] = JSON.parse(stringFlag(command, "--step") ?? "[]");
  const file = stringFlag(command, "--file");
  if (file !== undefined)
    steps.push(...splitLines(await readFile(file, "utf8")));
  if (booleanFlag(command, "--stdin"))
    steps.push(...splitLines(await readAll(process.stdin)));
  if (steps.length === 0)
    throw new UsageError("batch needs --step, --file or --stdin.");

  const continueOnError = booleanFlag(command, "--continue-on-error");
  let failed = 0;
  try {
    for (const step of steps) {
      const response = await runner.run(step);
      if (response.ok) {
        process.stdout.write(`✓ ${step}\n`);
        continue;
      }
      failed++;
      process.stderr.write(`✗ ${step}: ${String(response.error)}\n`);
      if (!continueOnError) break;
    }
  } finally {
    runner.close();
  }
  return failed === 0 ? 0 : 1;
}

async function printDevices(): Promise<number> {
  const devices = await listDevices();
  for (const device of devices) {
    const name = await emulatorName(device);
    process.stdout.write(
      `${device.serial} | ${name ?? device.model ?? "unknown"} | ${device.state}\n`,
    );
  }
  return 0;
}

/** An emulator's AVD name, read from its console through adb. */
function emulatorName(device: AdbDevice): Promise<string | undefined> {
  if (!device.serial.startsWith("emulator-") || device.state !== "device") {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => {
    execFile(
      adbBinary(),
      ["-s", device.serial, "emu", "avd", "name"],
      { timeout: 5_000 },
      (error, stdout) => {
        resolve(error ? undefined : stdout.split("\n")[0]?.trim() || undefined);
      },
    );
  });
}

const splitLines = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

// exitCode rather than process.exit(): stdout to a pipe is asynchronous in
// Node, and exiting at once cuts a large describe-ui off at 64 KB.
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    if (error instanceof UsageError)
      process.stderr.write(`Run 'adze --help' for usage.\n`);
    process.exitCode = error instanceof UsageError ? 64 : 1;
  },
);
