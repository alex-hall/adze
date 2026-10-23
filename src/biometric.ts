import {
  numberFlag,
  stringFlag,
  UsageError,
  type ParsedCommand,
} from "./args.js";
import type { CommandDefaults, CommandResult, Device } from "./commands.js";
import { androidKeycode } from "./keys.js";
import { activationPoint } from "./select.js";
import { describeWindows, flatten, type UiElement } from "./tree.js";

/**
 * `adze biometric match|nomatch|prompt|enroll`, for emulators.
 *
 * - `match` / `nomatch` touch the emulator's virtual fingerprint sensor with
 *   the enrolled finger, or with one it has never seen.
 * - `prompt` says whether a biometric prompt is showing. The prompt is a
 *   secure system window: it appears in no accessibility tree and shows black
 *   in screenshots, so it can only be seen from the window manager.
 * - `enroll` gives the emulator a screen-lock PIN (`--pin`, default 1111;
 *   Android won't enroll a fingerprint without one) and enrolls a
 *   fingerprint through the Settings screens. An English system image is
 *   assumed. Enrollment survives reboots, so it is needed once per emulator.
 */
export async function biometric(
  device: Device,
  command: ParsedCommand,
  defaults: CommandDefaults = {},
): Promise<CommandResult> {
  const action = command.positionals[0];
  switch (action) {
    case "match":
      await device.adb(["emu", "finger", "touch", ENROLLED_FINGER]);
      return { message: "Touched the sensor with the enrolled finger." };
    case "nomatch":
      await device.adb(["emu", "finger", "touch", UNKNOWN_FINGER]);
      return { message: "Touched the sensor with an unknown finger." };
    case "prompt": {
      const showing = biometricPromptShowing(
        await device.adb(["shell", "dumpsys", "window"]),
      );
      return {
        message: showing
          ? "A biometric prompt is showing."
          : "No biometric prompt is showing.",
        fields: { showing },
      };
    }
    case "enroll": {
      const pin = stringFlag(command, "--pin") ?? DEFAULT_PIN;
      const timeoutSeconds =
        numberFlag(command, "--wait-timeout") ??
        defaults.waitTimeoutSeconds ??
        120;
      const result = await enrollFingerprint(
        device,
        pin,
        timeoutSeconds * 1000,
      );
      return {
        message:
          result === "already"
            ? "A fingerprint is already enrolled."
            : `Fingerprint enrolled; the screen-lock PIN is ${pin}.`,
        fields: { enrolled: true, already: result === "already" },
      };
    }
    default:
      throw new UsageError(
        "biometric needs one of: match, nomatch, prompt, enroll.",
      );
  }
}

const ENROLLED_FINGER = "1";
const UNKNOWN_FINGER = "2";
const DEFAULT_PIN = "1111";

/** Whether `dumpsys window` shows a biometric prompt holding focus. */
export function biometricPromptShowing(dumpsysWindow: string): boolean {
  return /mCurrentFocus=Window\{[^}]*BiometricPrompt/.test(dumpsysWindow);
}

/** Whether `dumpsys fingerprint` reports at least one enrolled fingerprint. */
export function fingerprintEnrolled(dumpsysFingerprint: string): boolean {
  return [...dumpsysFingerprint.matchAll(/"count"\s*:\s*(\d+)/g)].some(
    (match) => Number(match[1]) > 0,
  );
}

export type EnrollStep =
  | { kind: "done"; target?: UiElement }
  | { kind: "pin" }
  | { kind: "tap"; target: UiElement }
  | { kind: "touch-sensor" }
  | { kind: "wait" };

/** What to do next on the Settings fingerprint-enrollment screens. */
export function nextEnrollStep(elements: readonly UiElement[]): EnrollStep {
  const visible = flatten(elements).filter((element) => element.visible);
  const find = (pattern: RegExp) =>
    visible.find(
      (element) =>
        pattern.test(element.AXLabel ?? "") ||
        pattern.test(element.android.text ?? ""),
    );
  if (find(/fingerprint added/i)) {
    const done = find(/^done$/i);
    return done ? { kind: "done", target: done } : { kind: "done" };
  }
  if (find(/(re-?enter|confirm|enter) your pin/i)) return { kind: "pin" };
  const agree = find(/^i agree$/i);
  if (agree) return { kind: "tap", target: agree };
  const more = find(/^more$/i);
  if (more) return { kind: "tap", target: more };
  if (find(/touch the sensor|lift|keep|finger|touch & hold/i))
    return { kind: "touch-sensor" };
  return { kind: "wait" };
}

async function enrollFingerprint(
  device: Device,
  pin: string,
  timeoutMs: number,
): Promise<"already" | "enrolled"> {
  if (
    fingerprintEnrolled(await device.adb(["shell", "dumpsys", "fingerprint"]))
  )
    return "already";
  await setPin(device, pin);
  await device.adb([
    "shell",
    "am",
    "start",
    "-a",
    "android.settings.FINGERPRINT_ENROLL",
  ]);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const step = nextEnrollStep(
      describeWindows(await device.windows(), device.info),
    );
    switch (step.kind) {
      case "done":
        if (step.target) await tap(device, step.target);
        return "enrolled";
      case "pin":
        await device.request({ cmd: "text", text: pin });
        await device.request({
          cmd: "key",
          keycode: androidKeycode("ENTER"),
          metaState: 0,
          holdMs: 0,
        });
        break;
      case "tap":
        await tap(device, step.target);
        break;
      case "touch-sensor":
        await device.adb(["emu", "finger", "touch", ENROLLED_FINGER]);
        break;
      case "wait":
        break;
    }
    await sleep(step.kind === "touch-sensor" ? 600 : 400);
  }
  throw new Error(
    `Fingerprint enrollment didn't finish within ${timeoutMs / 1000}s.`,
  );
}

async function setPin(device: Device, pin: string): Promise<void> {
  try {
    await device.adb(["shell", "locksettings", "set-pin", pin]);
  } catch {
    // Already set: fine if it's this PIN, a dead end if it isn't.
    try {
      await device.adb(["shell", "locksettings", "verify", "--old", pin]);
    } catch {
      throw new Error(
        `The device already has a screen lock that isn't PIN ${pin}; pass that one with --pin.`,
      );
    }
  }
}

async function tap(device: Device, element: UiElement): Promise<void> {
  const point = activationPoint(element, device.info);
  await device.request({ cmd: "tap", x: point.x, y: point.y });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
