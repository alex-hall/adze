import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export class AdbError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
  ) {
    super(message);
    this.name = "AdbError";
  }
}

/** The adb binary: `$ADZE_ADB`, the SDK's platform-tools, or `adb` on PATH. */
export function adbBinary(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ADZE_ADB) return env.ADZE_ADB;
  for (const sdk of [env.ANDROID_HOME, env.ANDROID_SDK_ROOT]) {
    if (!sdk) continue;
    const candidate = path.join(sdk, "platform-tools", "adb");
    if (existsSync(candidate)) return candidate;
  }
  const home = env.HOME;
  if (home) {
    const candidate = path.join(
      home,
      "Library",
      "Android",
      "sdk",
      "platform-tools",
      "adb",
    );
    if (existsSync(candidate)) return candidate;
  }
  return "adb";
}

export interface AdbDevice {
  serial: string;
  state: string;
  model?: string;
}

/** adb, run against one device. */
export class Adb {
  constructor(
    readonly serial: string,
    private readonly binary = adbBinary(),
  ) {}

  run(args: readonly string[], timeoutMs = 60_000): Promise<string> {
    return runAdb(this.binary, ["-s", this.serial, ...args], timeoutMs);
  }

  shell(command: string, timeoutMs = 60_000): Promise<string> {
    return this.run(["shell", command], timeoutMs);
  }

  /** The host port forwarded to `devicePort`, reusing an existing forward. */
  async forward(devicePort: number): Promise<number> {
    const list = await runAdb(this.binary, ["forward", "--list"]);
    for (const line of list.split("\n")) {
      const [serial, local, remote] = line.trim().split(/\s+/);
      if (
        serial === this.serial &&
        remote === `tcp:${devicePort}` &&
        local?.startsWith("tcp:")
      ) {
        return Number(local.slice(4));
      }
    }
    const allocated = await this.run(["forward", "tcp:0", `tcp:${devicePort}`]);
    const port = Number(allocated.trim());
    if (!Number.isInteger(port) || port <= 0) {
      throw new AdbError(`adb forward returned '${allocated.trim()}'.`, [
        "forward",
      ]);
    }
    return port;
  }
}

export async function listDevices(binary = adbBinary()): Promise<AdbDevice[]> {
  const output = await runAdb(binary, ["devices", "-l"]);
  return output
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial, state, ...details] = line.split(/\s+/);
      const model = details
        .find((detail) => detail.startsWith("model:"))
        ?.slice(6);
      return { serial: serial!, state: state!, ...(model && { model }) };
    });
}

/**
 * The device to use: the one named, else `$ANDROID_SERIAL`, else the only
 * device connected. AXe always needs `--udid`; adze lets a lone emulator go
 * unnamed, as adb does.
 */
export async function resolveSerial(
  named: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  binary = adbBinary(env),
): Promise<string> {
  if (named) return named;
  if (env.ANDROID_SERIAL) return env.ANDROID_SERIAL;
  const ready = (await listDevices(binary)).filter(
    (device) => device.state === "device",
  );
  if (ready.length === 1) return ready[0]!.serial;
  if (ready.length === 0)
    throw new AdbError("No Android device is connected.", ["devices"]);
  throw new AdbError(
    `${ready.length} devices are connected; pick one with --serial (${ready.map((device) => device.serial).join(", ")}).`,
    ["devices"],
  );
}

function runAdb(
  binary: string,
  args: readonly string[],
  timeoutMs = 60_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      [...args],
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr || error.message).trim();
          reject(new AdbError(`adb ${args.join(" ")} failed: ${detail}`, args));
          return;
        }
        resolve(stdout);
      },
    );
  });
}
