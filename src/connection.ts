import { createConnection, type Socket } from "node:net";

/** A request to the device server; `cmd` names the primitive. */
export type ServerRequest = { cmd: string } & Record<string, unknown>;

export interface ServerResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

export class ServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerError";
  }
}

/**
 * The connection is gone: the server died, the socket closed, or a
 * response never came. `requestSent` says whether the request that failed
 * reached the server; one that didn't is safe to retry on a new connection.
 */
export class ConnectionLostError extends ServerError {
  constructor(
    message: string,
    readonly requestSent: boolean,
  ) {
    super(message);
    this.name = "ConnectionLostError";
  }
}

const CLOSED = "The connection to the device server closed.";

/**
 * One connection to the device server through an `adb forward` port. The
 * protocol is JSON lines, one response per request, strictly in order;
 * requests made while one is in flight queue behind it.
 */
export class ServerConnection {
  private buffer = "";
  private readonly waiting: Array<(line: string | null) => void> = [];
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  private constructor(
    private readonly socket: Socket,
    /** The server's version, from its ready line. */
    readonly version: string,
  ) {}

  /**
   * Connects and waits for the ready line. `adb forward` accepts the TCP
   * connection even when nothing listens on the device and then closes it,
   * so a server that isn't running shows up as a close before ready.
   */
  static connect(port: number, timeoutMs = 5_000): Promise<ServerConnection> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ port, host: "127.0.0.1" });
      socket.setNoDelay(true);
      socket.setEncoding("utf8");
      let buffer = "";
      const timer = setTimeout(
        () => fail(new ServerError("The device server didn't answer.")),
        timeoutMs,
      );
      const fail = (error: Error) => {
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      };
      const onData = (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        clearTimeout(timer);
        socket.off("data", onData);
        socket.off("close", onClose);
        let ready: { ready?: boolean; version?: string };
        try {
          ready = JSON.parse(buffer.slice(0, newline));
        } catch {
          fail(
            new ServerError(
              `Unexpected first line from the device server: ${buffer.slice(0, 200)}`,
            ),
          );
          return;
        }
        if (!ready.ready) {
          fail(new ServerError("The device server didn't say it was ready."));
          return;
        }
        const connection = new ServerConnection(
          socket,
          ready.version ?? "unknown",
        );
        connection.attach(buffer.slice(newline + 1));
        resolve(connection);
      };
      const onClose = () =>
        fail(new ServerError("The device server isn't running."));
      socket.on("data", onData);
      socket.on("close", onClose);
      socket.on("error", (error) => fail(error));
    });
  }

  private attach(rest: string) {
    this.buffer = rest;
    this.socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        this.waiting.shift()?.(line);
      }
    });
    const onGone = () => {
      this.closed = true;
      for (const waiter of this.waiting.splice(0)) waiter(null);
    };
    this.socket.on("close", onGone);
    this.socket.on("error", onGone);
  }

  /** Sends one request and returns its response; a failed response throws. */
  request(request: ServerRequest, timeoutMs = 30_000): Promise<ServerResponse> {
    const run = this.queue.then(() => this.send(request, timeoutMs));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private send(
    request: ServerRequest,
    timeoutMs: number,
  ): Promise<ServerResponse> {
    if (this.closed) return Promise.reject(new ConnectionLostError(CLOSED, false));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A missed response would pair every later reply with the wrong
        // request, so a timeout ends the connection.
        this.close();
        reject(
          new ConnectionLostError(
            `The device server didn't answer '${request.cmd}' within ${timeoutMs}ms.`,
            true,
          ),
        );
      }, timeoutMs);
      this.waiting.push((line) => {
        clearTimeout(timer);
        if (line === null) {
          reject(new ConnectionLostError(CLOSED, true));
          return;
        }
        let response: ServerResponse;
        try {
          response = JSON.parse(line);
        } catch {
          this.close();
          reject(
            new ConnectionLostError(
              `The device server sent a line that isn't JSON: ${line.slice(0, 200)}`,
              true,
            ),
          );
          return;
        }
        if (!response.ok)
          reject(new ServerError(response.error ?? `'${request.cmd}' failed.`));
        else resolve(response);
      });
      this.socket.write(JSON.stringify(request) + "\n");
    });
  }

  close(): void {
    this.closed = true;
    this.socket.destroy();
  }
}
