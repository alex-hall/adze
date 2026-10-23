import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConnectionLostError,
  ServerConnection,
  ServerError,
} from "../src/connection.js";

/** A stand-in device server on a local port, scripted per test. */
async function fakeServer(
  onConnect: (socket: Socket) => void,
): Promise<{ port: number; server: Server }> {
  const server = createServer(onConnect);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { port: address.port, server };
}

/** Replies to each request line with `reply(request)`. */
const echoing =
  (
    reply: (request: { cmd: string; [key: string]: unknown }) => object,
    ready = '{"ready":true,"version":"1.0.0+test"}\n',
  ) =>
  (socket: Socket) => {
    socket.setEncoding("utf8");
    socket.write(ready);
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const request = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        socket.write(JSON.stringify(reply(request)) + "\n");
      }
    });
  };

let servers: Server[] = [];
afterEach(() => {
  servers.forEach((server) => server.close());
  servers = [];
});
const start = async (onConnect: (socket: Socket) => void) => {
  const { port, server } = await fakeServer(onConnect);
  servers.push(server);
  return port;
};

describe("ServerConnection", () => {
  it("reads the server's version from its ready line", async () => {
    const connection = await ServerConnection.connect(
      await start(echoing(() => ({ ok: true }))),
    );
    expect(connection.version).toBe("1.0.0+test");
    connection.close();
  });

  it("accepts a ready line split across packets", async () => {
    const port = await start((socket) => {
      socket.write('{"ready":tr');
      setTimeout(() => socket.write('ue,"version":"2"}\n'), 10);
    });
    const connection = await ServerConnection.connect(port);
    expect(connection.version).toBe("2");
    connection.close();
  });

  it("says the server isn't running when the connection closes before the ready line", async () => {
    // What adb forward does when nothing listens on the device.
    const port = await start((socket) => socket.end());
    await expect(ServerConnection.connect(port)).rejects.toThrow(
      "isn't running",
    );
  });

  it("pairs concurrent requests with their responses in order", async () => {
    const port = await start(
      echoing((request) => ({ ok: true, echo: request.n })),
    );
    const connection = await ServerConnection.connect(port);
    const responses = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => connection.request({ cmd: "ping", n })),
    );
    expect(responses.map((response) => response.echo)).toEqual([1, 2, 3, 4, 5]);
    connection.close();
  });

  it("turns a failed response into an error carrying the server's message", async () => {
    const port = await start(
      echoing(() => ({ ok: false, error: "No text field has focus." })),
    );
    const connection = await ServerConnection.connect(port);
    await expect(
      connection.request({ cmd: "text", text: "hi" }),
    ).rejects.toThrow(ServerError);
    await expect(
      connection.request({ cmd: "text", text: "hi" }),
    ).rejects.toThrow("No text field has focus.");
    connection.close();
  });

  it("ends the connection when a response never comes, and fails later requests as unsent", async () => {
    const port = await start((socket) => socket.write('{"ready":true}\n'));
    const connection = await ServerConnection.connect(port);
    const timedOut = connection.request({ cmd: "dump" }, 50);
    await expect(timedOut).rejects.toBeInstanceOf(ConnectionLostError);
    await expect(timedOut).rejects.toMatchObject({ requestSent: true });
    await expect(connection.request({ cmd: "ping" })).rejects.toMatchObject({
      requestSent: false,
    });
  });

  it("fails a request in flight when the server goes away", async () => {
    const port = await start((socket) => {
      socket.write('{"ready":true}\n');
      socket.on("data", () => socket.destroy());
    });
    const connection = await ServerConnection.connect(port);
    await expect(connection.request({ cmd: "dump" })).rejects.toMatchObject({
      name: "ConnectionLostError",
      requestSent: true,
    });
  });

  it("ends the connection on a line that isn't JSON", async () => {
    const port = await start((socket) => {
      socket.write('{"ready":true}\n');
      socket.on("data", () => socket.write("garbage\n"));
    });
    const connection = await ServerConnection.connect(port);
    await expect(connection.request({ cmd: "dump" })).rejects.toThrow(
      "isn't JSON",
    );
    await expect(connection.request({ cmd: "ping" })).rejects.toBeInstanceOf(
      ConnectionLostError,
    );
  });
});

describe("ServerConnection.watch", () => {
  it("delivers each change event after the server accepts the watch", async () => {
    let client: Socket | undefined;
    const port = await start((socket) => {
      client = socket;
      socket.setEncoding("utf8");
      socket.write('{"ready":true}\n');
      socket.once("data", () => socket.write('{"ok":true}\n'));
    });
    const connection = await ServerConnection.connect(port);
    let changes = 0;
    const watching = connection.watch(() => changes++);
    await new Promise((resolve) => setTimeout(resolve, 30));
    client!.write('{"event":"changed"}\n{"event":"changed"}\n');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(changes).toBe(2);
    connection.close();
    await expect(watching).resolves.toBeUndefined();
  });

  it("rejects when the server goes away, so the watcher can be restarted", async () => {
    let client: Socket | undefined;
    const port = await start((socket) => {
      client = socket;
      socket.write('{"ready":true}\n');
      socket.once("data", () => socket.write('{"ok":true}\n'));
    });
    const connection = await ServerConnection.connect(port);
    const watching = connection.watch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 30));
    client!.destroy();
    await expect(watching).rejects.toBeInstanceOf(ConnectionLostError);
  });
});
