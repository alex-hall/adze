import { createInterface } from "node:readline";
import {
  parseCommand,
  tokenizeLine,
  UsageError,
  type ParsedCommand,
} from "./args.js";
import { runCommand, type CommandDefaults, type Device } from "./commands.js";
import { ConnectionLostError } from "./connection.js";

export interface ClosableDevice extends Device {
  close(): void;
}

/** Commands a running `serve` or `batch` can't run inside itself. */
const NOT_IN_SERVE = new Set([
  "serve",
  "batch",
  "list-devices",
  "list-simulators",
]);

/**
 * Runs one `serve`/`batch` line against the device. The device comes from
 * `connect`, opened on first use and reopened after the device server goes
 * away (an emulator restart, a killed server), so a long-lived caller
 * recovers on its next command.
 */
export class LineRunner {
  private device: Promise<ClosableDevice> | undefined;

  constructor(
    private readonly connect: () => Promise<ClosableDevice>,
    private readonly defaults: CommandDefaults,
  ) {}

  ready(): Promise<ClosableDevice> {
    this.device ??= this.connect().catch((error) => {
      this.device = undefined;
      throw error;
    });
    return this.device;
  }

  /** The JSON response for one line, never throwing. */
  async run(line: string): Promise<Record<string, unknown>> {
    try {
      const command = parseCommand(tokenizeLine(line));
      if (NOT_IN_SERVE.has(command.name))
        throw new UsageError(
          `'${command.name}' can't run inside serve or batch.`,
        );
      if (command.name === "type" && command.flags.has("--stdin")) {
        throw new UsageError(
          "type --stdin can't run inside serve or batch; pass the text instead.",
        );
      }
      return { ok: true, ...(await this.runWithReconnect(command)).fields };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Runs a command, reconnecting when the connection turns out to be gone.
   * The command is retried once on the new connection only if none of its
   * requests reached the server — a server that died while idle — so a
   * retry never repeats a touch or a keystroke.
   */
  private async runWithReconnect(command: ParsedCommand) {
    for (let attempt = 1; ; attempt++) {
      const device = await this.ready();
      let delivered = 0;
      const counting: Device = {
        serial: device.serial,
        get info() {
          return device.info;
        },
        windows: () => device.windows(),
        // Counts requests that reached the server. Reads (`windows`) don't
        // need counting: repeating one changes nothing.
        request: async (request, timeoutMs) => {
          try {
            const response = await device.request(request, timeoutMs);
            delivered++;
            return response;
          } catch (error) {
            if (!(error instanceof ConnectionLostError) || error.requestSent)
              delivered++;
            throw error;
          }
        },
      };
      try {
        return await runCommand(counting, command, this.defaults);
      } catch (error) {
        if (!(error instanceof ConnectionLostError)) throw error;
        this.drop(device);
        if (attempt > 1 || delivered > 0) throw error;
      }
    }
  }

  close(): void {
    void this.device?.then((device) => device.close()).catch(() => undefined);
    this.device = undefined;
  }

  private drop(device: ClosableDevice) {
    device.close();
    this.device = undefined;
  }
}

/**
 * AXe's serve protocol over stdin/stdout: `{"ready":true}` once the device
 * server is reachable, then one `{"ok":...}` line per command line, in
 * order. Ends when stdin closes.
 */
export async function serve(
  runner: LineRunner,
  input: NodeJS.ReadableStream,
  write: (line: string) => void,
): Promise<void> {
  try {
    await runner.ready();
  } catch (error) {
    write(
      JSON.stringify({
        ready: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return;
  }
  write(JSON.stringify({ ready: true }));
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === "") continue;
    write(JSON.stringify(await runner.run(line)));
  }
  runner.close();
}
