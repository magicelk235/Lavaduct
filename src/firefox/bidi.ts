import type { ChildProcess } from "node:child_process";
import { readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { launchFirefox } from "./launch.js";
import type { FirefoxInstall } from "./locate.js";
import { profileInUse } from "./profiles.js";

// Firefox writes the agent's address here once it listens, and removes it on exit.
const SERVER_FILE = "WebDriverBiDiServer.json";
const START_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 60_000;
const QUIT_TIMEOUT_MS = 30_000;
// webExtension.install exists from 137, but only installs temporarily (and
// skips the signature check) from 138.
const MIN_TEMPORARY_INSTALL_VERSION = 138;

interface Pending {
  resolve(result: unknown): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

/** An error Firefox returned for a command, e.g. `no such web extension`. */
class BidiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function readServerPort(file: string): number | undefined {
  try {
    const data: unknown = JSON.parse(readFileSync(file, "utf-8"));
    const port = data && typeof data === "object" && "ws_port" in data ? data.ws_port : undefined;
    return typeof port === "number" && port > 0 ? port : undefined;
  } catch {
    // Not written yet, or caught mid-write.
    return undefined;
  }
}

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolvePromise, reject) => {
    // The agent listens on IPv4 loopback only. A BiDi-only session lives at
    // /session; Node's WebSocket sends no Origin header, which the agent requires.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/session`);
    ws.addEventListener("open", () => resolvePromise(ws), { once: true });
    ws.addEventListener("error", () => reject(new Error(`can't connect to port ${port}`)), { once: true });
  });
}

/**
 * A WebDriver BiDi session with a Firefox started for it. Firefox only starts
 * its remote agent when launched with --remote-debugging-port, so the session
 * always comes with its own Firefox process.
 */
export class BidiSession {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;
  private browserVersion = "";

  private constructor(
    private readonly ws: WebSocket,
    private readonly child: ChildProcess,
    private readonly profilePath: string,
  ) {
    ws.addEventListener("message", (event) => this.onMessage(event.data));
    ws.addEventListener("close", () => this.onClose());
  }

  /**
   * Launch Firefox on the profile with its remote agent on a free port and open
   * a session. Fails when a running Firefox already has the profile open:
   * that Firefox would take over the launch without starting the agent.
   */
  static async start(
    install: FirefoxInstall,
    profilePath: string,
    opts: { headless?: boolean } = {},
  ): Promise<BidiSession> {
    const profile = resolve(profilePath);
    if (profileInUse(profile)) {
      throw new Error(
        `Firefox already has the profile at ${profile} open. Quit it first: ` +
          "the remote agent only starts with a new Firefox process.",
      );
    }
    const serverFile = join(profile, SERVER_FILE);
    // Left behind by a Firefox that didn't shut down cleanly; its port is stale.
    rmSync(serverFile, { force: true });

    const headless = opts.headless === true;
    const child = launchFirefox(install, ["--remote-debugging-port", "0", "--profile", profile], { headless });
    let failure: string | undefined;
    child.once("error", (err) => {
      failure = err.message;
    });
    // Exit code 0 can mean Firefox restarted itself in a new process, so only
    // a failing exit ends the wait early.
    child.once("exit", (code, signal) => {
      if (code !== 0) failure = signal ? `Firefox was stopped by ${signal}` : `Firefox exited with code ${code}`;
    });

    const deadline = Date.now() + START_TIMEOUT_MS;
    let ws: WebSocket | undefined;
    let lastError = "its remote agent never came up";
    while (!ws) {
      if (failure) break;
      const port = readServerPort(serverFile);
      if (port) {
        ws = await connect(port).catch((err: Error) => {
          lastError = err.message;
          return undefined;
        });
      }
      if (ws || Date.now() > deadline) break;
      await sleep(100);
    }
    if (!ws) {
      if (headless) child.kill();
      throw new Error(`Couldn't start a remote session with ${install.binary}: ${failure ?? lastError}.`);
    }

    const session = new BidiSession(ws, child, profile);
    try {
      const result = await session.command("session.new", { capabilities: {} });
      const caps = result && typeof result === "object" && "capabilities" in result ? result.capabilities : undefined;
      const version = caps && typeof caps === "object" && "browserVersion" in caps ? caps.browserVersion : undefined;
      session.browserVersion = typeof version === "string" ? version : install.version;
    } catch (err) {
      ws.close();
      if (headless) child.kill();
      throw err;
    }
    return session;
  }

  /**
   * Install an add-on from an unpacked directory or an .xpi/.zip, temporarily:
   * no signature check, gone when Firefox restarts. Firefox loads it in place,
   * so the files must stay put while Firefox runs. Returns the add-on ID.
   */
  async installExtension(path: string): Promise<string> {
    const major = Number.parseInt(this.browserVersion, 10);
    if (major < MIN_TEMPORARY_INSTALL_VERSION) {
      throw new Error(
        `Temporary installs need Firefox ${MIN_TEMPORARY_INSTALL_VERSION} or later; this one is ${this.browserVersion}.`,
      );
    }
    const abs = resolve(path);
    const stat = statSync(abs, { throwIfNoEntry: false });
    if (!stat) throw new Error(`Nothing to install at ${abs}.`);
    let result: unknown;
    try {
      result = await this.command("webExtension.install", {
        extensionData: { type: stat.isDirectory() ? "path" : "archivePath", path: abs },
      });
    } catch (err) {
      throw new Error(`Firefox refused the add-on at ${abs}: ${(err as Error).message}`);
    }
    const id = result && typeof result === "object" && "extension" in result ? result.extension : undefined;
    if (typeof id !== "string") throw new Error("Firefox installed the add-on but didn't report its ID.");
    return id;
  }

  /** Uninstall an add-on the way about:addons does, removing its data too. */
  async uninstallExtension(id: string): Promise<void> {
    try {
      await this.command("webExtension.uninstall", { extension: id });
    } catch (err) {
      if (err instanceof BidiError && err.code === "no such web extension") {
        throw new Error(`No add-on with the ID ${id} is installed in this profile.`);
      }
      throw err;
    }
  }

  /** End the session and disconnect. Firefox keeps running. */
  async end(): Promise<void> {
    try {
      if (!this.closed) await this.command("session.end", {});
    } finally {
      this.ws.close();
      this.child.unref();
    }
  }

  /** Quit Firefox and wait until it has let go of the profile. */
  async closeBrowser(): Promise<void> {
    if (!this.closed) {
      try {
        await this.command("browser.close", {});
      } catch (err) {
        // Firefox may drop the connection before its answer arrives.
        if (!this.closed) throw err;
      }
    }
    const deadline = Date.now() + QUIT_TIMEOUT_MS;
    const running = (): boolean =>
      (this.child.exitCode === null && this.child.signalCode === null) || profileInUse(this.profilePath);
    while (running()) {
      if (Date.now() > deadline) throw new Error(`Firefox didn't quit within ${QUIT_TIMEOUT_MS / 1000} s.`);
      await sleep(100);
    }
    this.ws.close();
  }

  private command(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("The connection to Firefox is closed."));
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Firefox didn't answer ${method} within ${COMMAND_TIMEOUT_MS / 1000} s.`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  private onMessage(data: unknown): void {
    let message: unknown;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    // Events carry no id; this client subscribes to none.
    if (!message || typeof message !== "object" || !("id" in message) || typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if ("type" in message && message.type === "error") {
      const code = "error" in message && typeof message.error === "string" ? message.error : "unknown error";
      const text = "message" in message && typeof message.message === "string" ? message.message : code;
      pending.reject(new BidiError(code, text));
    } else {
      pending.resolve("result" in message ? message.result : undefined);
    }
  }

  private onClose(): void {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Firefox closed the remote connection."));
    }
    this.pending.clear();
  }
}
