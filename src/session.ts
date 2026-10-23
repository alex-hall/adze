import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Adb, resolveSerial } from "./adb.js";
import {
  ServerConnection,
  type ServerRequest,
  type ServerResponse,
} from "./connection.js";
import type { AndroidWindow, ScreenSize } from "./tree.js";

const SERVER_PACKAGE = "dev.adze.server";
const SERVER_INSTRUMENTATION = `${SERVER_PACKAGE}/.ServerInstrumentation`;
const DEVICE_PORT = 7912;
const START_TIMEOUT_MS = 20_000;

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** The CLI's own version. */
export const VERSION: string = JSON.parse(
  readFileSync(path.join(packageRoot, "package.json"), "utf8"),
).version;

/** The device server APK: `$ADZE_SERVER_APK`, else the one shipped in the package. */
export function serverApkPath(env: NodeJS.ProcessEnv = process.env): string {
  const apk =
    env.ADZE_SERVER_APK ?? path.join(packageRoot, "apk", "adze-server.apk");
  if (!existsSync(apk)) {
    throw new Error(
      `The adze device server APK is missing at ${apk}. Run 'npm run build:server'.`,
    );
  }
  return apk;
}

/**
 * The exact server build this CLI ships with, e.g. "0.1.0+3f9c2a1b", read
 * from the `.version` file the server build writes beside its APK. Any other
 * build on the device — older, newer, or a rebuild of the same version — is
 * replaced.
 */
export function expectedServerVersion(apk = serverApkPath()): string {
  const file = apk.replace(/\.apk$/, ".version");
  if (!existsSync(file)) {
    throw new Error(
      `${file} is missing; it is written by 'npm run build:server' beside the APK.`,
    );
  }
  return readFileSync(file, "utf8").trim();
}

export interface DeviceInfo extends ScreenSize {
  sdk: number;
  density: number;
}

export interface SessionOptions {
  serial?: string;
  log?: (message: string) => void;
}

/**
 * A live connection to one device's adze server. Opening a session makes
 * sure the right server version is installed and running — installing,
 * upgrading and starting it as needed — so callers never manage it.
 */
export class Session {
  private constructor(
    readonly serial: string,
    private readonly adb_: Adb,
    private connection: ServerConnection,
    /** Refreshed by every `windows()`: rotation changes the screen size. */
    public info: DeviceInfo,
    /** The host port forwarded to the device server. */
    private readonly port: number,
  ) {}

  static async open(options: SessionOptions = {}): Promise<Session> {
    const log = options.log ?? (() => {});
    const serial = await resolveSerial(options.serial);
    const adb = new Adb(serial);
    const connection = await connectToServer(adb, log);
    // The forward connectToServer set up, looked up again (adb reuses it).
    const port = await adb.forward(DEVICE_PORT);
    const info = (await connection.request({
      cmd: "info",
    })) as unknown as DeviceInfo;
    return new Session(serial, adb, connection, info, port);
  }

  adb(args: readonly string[], timeoutMs?: number): Promise<string> {
    return this.adb_.run(args, timeoutMs);
  }

  /**
   * Calls `listener` each time the screen may have changed, until the
   * returned promise settles: it resolves when `stop` is called, and rejects
   * if the device server goes away. Uses a connection of its own, so
   * requests on this session aren't held up.
   */
  async watchChanges(
    listener: () => void,
  ): Promise<{ stop: () => void; ended: Promise<void> }> {
    const watcher = await ServerConnection.connect(this.port);
    const ended = watcher.watch(listener);
    return { stop: () => watcher.close(), ended };
  }

  request(request: ServerRequest, timeoutMs?: number): Promise<ServerResponse> {
    return this.connection.request(request, timeoutMs);
  }

  async windows(): Promise<AndroidWindow[]> {
    const response = await this.request({ cmd: "dump" });
    if (
      typeof response.widthDp === "number" &&
      typeof response.heightDp === "number"
    ) {
      this.info = {
        ...this.info,
        widthDp: response.widthDp,
        heightDp: response.heightDp,
      };
    }
    return response.windows as AndroidWindow[];
  }

  close(): void {
    this.connection.close();
  }
}

async function connectToServer(
  adb: Adb,
  log: (message: string) => void,
): Promise<ServerConnection> {
  const apk = serverApkPath();
  const expected = expectedServerVersion(apk);
  const port = await adb.forward(DEVICE_PORT);
  const probe = () =>
    ServerConnection.connect(port, PROBE_TIMEOUT_MS).catch(() => undefined);

  const running = await probe();
  if (running?.version === expected) return running;
  running?.close();

  // Starting is a critical section: `am instrument` force-stops any server
  // already running, so two adze processes starting it at once would kill
  // each other's. They take turns per device, and whoever goes second
  // finds the first one's server up.
  return withDeviceLock(adb.serial, async () => {
    const current = await probe();
    if (current?.version === expected) return current;
    const wrongBuildRunning = current !== undefined;
    current?.close();

    // Running but not answering yet: being started from elsewhere, or busy
    // starting up. Give it the start-up window before replacing it.
    if (!wrongBuildRunning && (await serverProcessRunning(adb))) {
      log(`Waiting for the adze server already starting on ${adb.serial}.`);
      const started = await waitForServer(port);
      if (started?.version === expected) return started;
      started?.close();
    }

    const installed = await installedVersion(adb);
    if (installed !== expected) {
      log(
        `Installing adze server ${expected} on ${adb.serial}${installed ? ` (was ${installed})` : ""}.`,
      );
      await installServer(adb, apk, log);
    }
    log(`Starting adze server on ${adb.serial}.`);
    await adb.shell(`am force-stop ${SERVER_PACKAGE}`);
    // Detached with nohup and every stream redirected: a server owned by this
    // adb session would die the moment adb drops the connection, and an open
    // stdin can keep `adb shell` waiting.
    await adb.shell(
      `nohup am instrument -w -e port ${DEVICE_PORT} ${SERVER_INSTRUMENTATION} </dev/null >/dev/null 2>&1 &`,
    );

    const connection = await waitForServer(port);
    if (!connection) {
      throw new Error(
        `The adze server didn't start on ${adb.serial} within ${START_TIMEOUT_MS / 1000}s. ` +
          `Its log: adb -s ${adb.serial} logcat -d -s adze AndroidRuntime`,
      );
    }
    if (connection.version === expected) return connection;
    connection.close();
    throw new Error(
      `The device runs adze server ${connection.version}, but this CLI ships ${expected}.`,
    );
  });
}

const PROBE_TIMEOUT_MS = 10_000;

/** Polls until a server answers on the port, or the start-up window passes. */
async function waitForServer(
  port: number,
): Promise<ServerConnection | undefined> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const connection = await ServerConnection.connect(
      port,
      PROBE_TIMEOUT_MS,
    ).catch(() => undefined);
    if (connection) return connection;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return undefined;
}

async function serverProcessRunning(adb: Adb): Promise<boolean> {
  const output = await adb.shell(`pidof ${SERVER_PACKAGE} || true`);
  return output.trim() !== "";
}

const LOCK_STALE_MS = 60_000;

/**
 * Runs `work` while holding a per-device lock on this host: a directory,
 * because creating one is atomic. A lock older than any start could take is
 * left over from a killed process and is broken.
 */
async function withDeviceLock<T>(
  serial: string,
  work: () => Promise<T>,
): Promise<T> {
  const lock = path.join(
    os.tmpdir(),
    `adze-${serial.replace(/[^\w.-]/g, "_")}.lock`,
  );
  const deadline = Date.now() + LOCK_STALE_MS + START_TIMEOUT_MS;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = await stat(lock).then(
        (info) => Date.now() - info.mtimeMs,
        () => 0,
      );
      if (age > LOCK_STALE_MS) await rm(lock, { recursive: true, force: true });
      else if (Date.now() > deadline)
        throw new Error(`Timed out waiting for ${lock}.`);
      else await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  try {
    return await work();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

/**
 * Installs the server APK over whatever is there. Debug builds are signed
 * with each machine's own debug key, and Android refuses to upgrade an app
 * with a differently signed one — a server installed from the npm package
 * and then rebuilt locally, say. The server holds no data, so that case
 * uninstalls the old copy and installs again.
 */
async function installServer(
  adb: Adb,
  apk: string,
  log: (message: string) => void,
): Promise<void> {
  try {
    await adb.run(["install", "-r", apk], 120_000);
  } catch (error) {
    const signedDifferently =
      error instanceof Error &&
      /INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match/i.test(
        error.message,
      );
    if (!signedDifferently) throw error;
    log(
      "The installed adze server was signed with a different key; replacing it.",
    );
    await adb.run(["uninstall", SERVER_PACKAGE]);
    await adb.run(["install", apk], 120_000);
  }
}

async function installedVersion(adb: Adb): Promise<string | undefined> {
  const output = await adb.shell(`dumpsys package ${SERVER_PACKAGE}`);
  return /versionName=(\S+)/.exec(output)?.[1];
}
