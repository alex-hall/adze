import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { ServerRequest, ServerResponse } from "../src/connection.js";
import { ConnectionLostError } from "../src/connection.js";
import { LineRunner, serve, type ClosableDevice } from "../src/serve.js";
import type { AndroidWindow } from "../src/tree.js";
import { node, SCREEN, signInScreen, window } from "./fixtures.js";

/** A device that plays back screens and records what it was asked to do. */
class FakeDevice implements ClosableDevice {
  readonly serial = "emulator-5554";
  readonly info = SCREEN;
  readonly requests: ServerRequest[] = [];
  closed = false;

  constructor(private readonly screens: AndroidWindow[][]) {}

  async windows(): Promise<AndroidWindow[]> {
    return this.screens.length > 1 ? this.screens.shift()! : this.screens[0]!;
  }

  async request(request: ServerRequest): Promise<ServerResponse> {
    this.requests.push(request);
    return { ok: true };
  }

  close(): void {
    this.closed = true;
  }
}

const runnerFor = (device: ClosableDevice) =>
  new LineRunner(async () => device, {});

describe("serve", () => {
  it("speaks the serve protocol: a ready line, then one JSON line per command", async () => {
    const input = new PassThrough();
    const lines: string[] = [];
    const done = serve(
      runnerFor(new FakeDevice([signInScreen()])),
      input,
      (line) => lines.push(line),
    );
    input.end("tap --id sign-in\ndescribe-ui\nfly away\n");
    await done;

    const [ready, tap, describe, unknown] = lines.map((line) =>
      JSON.parse(line),
    );
    expect(ready).toEqual({ ready: true });
    expect(tap).toEqual({ ok: true });
    expect(describe.ok).toBe(true);
    expect(describe.tree[0].AXLabel).toBe("Example App");
    expect(unknown).toEqual({ ok: false, error: "Unknown command 'fly'." });
  });

  it("reports a failed start instead of a ready line", async () => {
    const lines: string[] = [];
    const runner = new LineRunner(async () => {
      throw new Error("No Android device is connected.");
    }, {});
    await serve(runner, new PassThrough(), (line) => lines.push(line));
    expect(JSON.parse(lines[0]!)).toEqual({
      ready: false,
      error: "No Android device is connected.",
    });
  });
});

describe("LineRunner", () => {
  it("taps an element at the center of its frame, in dp", async () => {
    const device = new FakeDevice([signInScreen()]);
    await runnerFor(device).run("tap --id sign-in");
    expect(device.requests).toEqual([{ cmd: "tap", x: 200, y: 728 }]);
  });

  it("waits for an element that hasn't appeared yet", async () => {
    const empty = [window(node())];
    const device = new FakeDevice([empty, empty, signInScreen()]);
    const response = await runnerFor(device).run(
      "tap --label 'Sign in' --wait-timeout 2 --poll-interval 0.01".replace(
        /'/g,
        '"',
      ),
    );
    expect(response).toEqual({ ok: true });
  });

  it("gives up with the no-match wording once the wait runs out", async () => {
    const device = new FakeDevice([[window(node())]]);
    const response = await runnerFor(device).run(
      'tap --label "Sign in" --wait-timeout 0.05 --poll-interval 0.01',
    );
    expect(response.ok).toBe(false);
    expect(response.error).toContain(
      "No accessibility element matched --label 'Sign in'",
    );
  });

  it("types text exactly, including characters key events can't carry", async () => {
    const device = new FakeDevice([signInScreen()]);
    await runnerFor(device).run('type "Alice’s note 👋"');
    expect(device.requests).toEqual([{ cmd: "text", text: "Alice’s note 👋" }]);
  });

  it("sends Cmd+A as Ctrl+A", async () => {
    const device = new FakeDevice([signInScreen()]);
    await runnerFor(device).run("key-combo --modifiers 227 --key 4");
    expect(device.requests[0]).toMatchObject({ cmd: "key", keycode: 29 });
    expect((device.requests[0]!.metaState as number) & 0x1000).toBeTruthy();
  });

  it("retries a command on a new connection when the server died while idle", async () => {
    let connects = 0;
    const healthy = new FakeDevice([signInScreen()]);
    const runner = new LineRunner(
      async () => (connects++ === 0 ? deadDevice(false) : healthy),
      {},
    );
    expect(await runner.run("tap -x 1 -y 2")).toEqual({ ok: true });
    expect(connects).toBe(2);
    expect(healthy.requests).toEqual([{ cmd: "tap", x: 1, y: 2 }]);
  });

  it("doesn't repeat a command the server may have acted on, but reconnects for the next", async () => {
    let connects = 0;
    const healthy = new FakeDevice([signInScreen()]);
    const runner = new LineRunner(
      async () => (connects++ === 0 ? deadDevice(true) : healthy),
      {},
    );
    expect((await runner.run("tap -x 1 -y 2")).ok).toBe(false);
    expect(healthy.requests).toEqual([]);
    expect(await runner.run("tap -x 1 -y 2")).toEqual({ ok: true });
  });

  it("doesn't repeat a command once part of it reached the server", async () => {
    // touch --down --up is two requests: the down lands, then the server dies.
    let calls = 0;
    const halfway: ClosableDevice = {
      serial: "emulator-5554",
      info: SCREEN,
      windows: async () => signInScreen(),
      request: async () => {
        if (calls++ === 0) return { ok: true };
        throw new ConnectionLostError("The connection to the device server closed.", false);
      },
      close: () => {},
    };
    const healthy = new FakeDevice([signInScreen()]);
    let connects = 0;
    const runner = new LineRunner(async () => (connects++ === 0 ? halfway : healthy), {});
    expect((await runner.run("touch -x 1 -y 2 --down --up --delay 0")).ok).toBe(false);
    expect(healthy.requests).toEqual([]);
  });

  it("types a newline as the Return key", async () => {
    const device = new FakeDevice([signInScreen()]);
    await runnerFor(device).run('type "search me\n"');
    expect(device.requests).toEqual([
      { cmd: "text", text: "search me" },
      { cmd: "key", keycode: 66, metaState: 0, holdMs: 0 },
    ]);
  });

  it("refuses commands that can't run inside serve", async () => {
    const response = await runnerFor(new FakeDevice([signInScreen()])).run(
      "serve",
    );
    expect(response.ok).toBe(false);
  });
});

/** A device whose connection is already gone; `sent` says whether its request got out. */
function deadDevice(sent: boolean): ClosableDevice {
  return {
    serial: "emulator-5554",
    info: SCREEN,
    windows: async () => signInScreen(),
    request: async () => {
      throw new ConnectionLostError("The connection to the device server closed.", sent);
    },
    close: () => {},
  };
}
