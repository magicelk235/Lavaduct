import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { NAME } from "../name.js";
import { launchFirefox } from "./launch.js";
import type { FirefoxInstall } from "./locate.js";
import { profileInUse } from "./profiles.js";

// Where the Firefox started on a profile listens, kept in the profile the way
// Firefox keeps WebDriverBiDiServer.json, so a later run can find it.
const SERVER_FILE = `${NAME}-debugger.json`;
const SOCKET_DIR_PREFIX = `${NAME}-debugger-`;
const SOCKET_NAME = "socket";
// Firefox's Unix socket addresses hold 104 bytes, the closing NUL included.
const MAX_SOCKET_PATH = 103;
const START_TIMEOUT_MS = 30_000;
const GREETING_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 60_000;
// Generous for a decimal byte count; anything longer isn't a packet header.
const MAX_HEADER_DIGITS = 20;

/** Where a Firefox devtools server listens: a Unix socket, or a loopback TCP port on Windows. */
export type DebuggerAddress = { path: string } | { port: number };

/** A devtools protocol packet: a JSON object. */
export type Packet = Record<string, unknown>;

function isObject(value: unknown): value is Packet {
  return typeof value === "object" && value !== null;
}

/** An error reply from a devtools actor, e.g. Firefox refusing an add-on. */
export class RdpError extends Error {}

/**
 * Splits the byte stream from a devtools server into packets, each a decimal
 * byte count, a colon and that many bytes of UTF-8 JSON. Packets may arrive
 * split anywhere, including inside a character.
 */
class PacketReader {
  private buffer: Buffer = Buffer.alloc(0);

  /** The packets `chunk` completes. Throws when the stream isn't the devtools protocol. */
  push(chunk: Buffer): unknown[] {
    this.buffer = this.buffer.length > 0 ? Buffer.concat([this.buffer, chunk]) : chunk;
    const packets: unknown[] = [];
    for (;;) {
      let colon = -1;
      for (let i = 0; i < this.buffer.length; i++) {
        const byte = this.buffer[i];
        if (byte === 0x3a && i > 0) {
          colon = i;
          break;
        }
        // Firefox sends bulk packets ("bulk <actor> …") only to clients that ask for them.
        if (byte < 0x30 || byte > 0x39 || i === MAX_HEADER_DIGITS) throw new Error("not a devtools packet");
      }
      if (colon < 0) return packets;
      const end = colon + 1 + Number(this.buffer.toString("latin1", 0, colon));
      if (this.buffer.length < end) return packets;
      packets.push(JSON.parse(this.buffer.toString("utf-8", colon + 1, end)));
      this.buffer = this.buffer.subarray(end);
    }
  }
}

function readServerFile(profile: string): DebuggerAddress | undefined {
  try {
    const data: unknown = JSON.parse(readFileSync(join(profile, SERVER_FILE), "utf-8"));
    if (isObject(data) && typeof data.path === "string") return { path: data.path };
    if (isObject(data) && typeof data.port === "number") return { port: data.port };
  } catch {
    // No Firefox was started on this profile, or the file is damaged.
  }
  return undefined;
}

/** Clear what a Firefox that has quit left behind of its devtools server. */
export function forgetServer(profile: string): void {
  const address = readServerFile(profile);
  // Only a socket in a folder start() made, whatever else the file names.
  if (address && "path" in address) {
    const dir = dirname(address.path);
    if (basename(address.path) === SOCKET_NAME && basename(dir).startsWith(SOCKET_DIR_PREFIX)) {
      rmSync(address.path, { force: true });
      try {
        rmdirSync(dir);
      } catch {
        // Already gone, or holding something that isn't ours.
      }
    }
  }
  rmSync(join(profile, SERVER_FILE), { force: true });
}

async function freePort(): Promise<number> {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  server.close();
  await once(server, "close");
  return port;
}

/**
 * A fresh address for the devtools server. Whoever reaches it runs code in
 * Firefox with full privileges, and the server asks for no credentials. On
 * macOS and Linux it is a Unix socket in a folder only this user can enter
 * (mkdtemp makes it 0700; Firefox makes the socket itself 0666). Windows
 * Firefox has no Unix sockets, so there it is a free loopback port, which any
 * local process can connect to while Firefox runs.
 */
async function newAddress(install: FirefoxInstall, profile: string): Promise<DebuggerAddress> {
  if (process.platform === "win32") return { port: await freePort() };
  // The folder goes in the profile, which Snap and Flatpak Firefox can see and
  // which takes it along when it goes, unless that makes the path too long.
  // mkdtemp adds six characters to the prefix.
  const inProfile = join(profile, `${SOCKET_DIR_PREFIX}XXXXXX`, SOCKET_NAME);
  const dir = mkdtempSync(
    join(install.sandbox || Buffer.byteLength(inProfile) <= MAX_SOCKET_PATH ? profile : tmpdir(), SOCKET_DIR_PREFIX),
  );
  const path = join(dir, SOCKET_NAME);
  if (Buffer.byteLength(path) > MAX_SOCKET_PATH) {
    rmdirSync(dir);
    throw new Error(
      `Firefox can't listen on ${path}: a socket path can't be longer than ${MAX_SOCKET_PATH} bytes. ` +
        (install.sandbox ? "Pass a --profile with a shorter path." : "Point TMPDIR at a folder with a shorter path."),
    );
  }
  return { path };
}

/**
 * A fresh address for a devtools server on the profile, after clearing what
 * an earlier server left, recorded in the profile so attach() finds it.
 */
export async function claimServerAddress(install: FirefoxInstall, profilePath: string): Promise<DebuggerAddress> {
  const profile = resolve(profilePath);
  forgetServer(profile);
  const address = await newAddress(install, profile);
  writeFileSync(join(profile, SERVER_FILE), JSON.stringify(address));
  return address;
}

/** The address as --start-debugger-server takes it: a socket path or a port. */
export function serverArgument(address: DebuggerAddress): string {
  return "path" in address ? address.path : String(address.port);
}

interface Pending {
  /** The actor whose reply settles this. */
  actor: string;
  resolve(reply: Packet): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

interface EventWaiter {
  type: string;
  match(event: Packet): boolean;
  resolve(event: Packet): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

/**
 * A connection to Firefox's devtools server over the Remote Debugging
 * Protocol, the one web-ext run and about:debugging use to load temporary
 * add-ons. Firefox starts the server when launched with
 * --start-debugger-server and keeps it listening until it quits, so a later
 * run can connect again. Unlike WebDriver, the server doesn't mark the browser
 * as automated: pages keep seeing navigator.webdriver as false.
 */
export class RdpSession {
  private readonly reader = new PacketReader();
  private pending: Pending | undefined;
  // Requests go one at a time; each waits for the one before.
  private queue: Promise<unknown> = Promise.resolve();
  private failure: Error | undefined;
  private connected = false;
  private addonsActor: string | undefined;
  // Watched event types, and the events of them nobody has taken yet.
  private readonly events = new Map<string, Packet[]>();
  private readonly eventWaiters = new Set<EventWaiter>();
  private readonly ended = Promise.withResolvers<void>();
  /** Resolves when the connection ends, whichever side ends it. */
  readonly disconnected: Promise<void> = this.ended.promise;

  private constructor(
    private readonly socket: Socket,
    private readonly where: string,
  ) {
    socket.on("connect", () => {
      this.connected = true;
    });
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", (err) => {
      this.fail(
        new Error(
          this.connected
            ? `Lost the connection to Firefox's devtools server: ${err.message}`
            : `Can't connect to Firefox's devtools server at ${where}: ${err.message}`,
        ),
      );
    });
    socket.on("close", () => {
      this.fail(new Error("Firefox closed its devtools connection."));
      this.ended.resolve();
    });
  }

  /** Connect to the devtools server at `address` and wait for its greeting. */
  static async connect(address: DebuggerAddress, timeoutMs = GREETING_TIMEOUT_MS): Promise<RdpSession> {
    const where = "path" in address ? address.path : `127.0.0.1:${address.port}`;
    const socket = "path" in address ? createConnection(address.path) : createConnection(address.port, "127.0.0.1");
    const session = new RdpSession(socket, where);
    try {
      await session.expectReply("root", timeoutMs, `Firefox's devtools server at ${where} didn't greet within ${timeoutMs / 1000} s.`);
    } catch (err) {
      session.end();
      throw err;
    }
    return session;
  }

  /**
   * Launch Firefox on the profile with its devtools server on a fresh address,
   * and connect. The profile's prefs must allow the server; see
   * enableDebuggerServerInProfile. Fails when a running Firefox already has the
   * profile open. A headless Firefox stays tied to this process.
   */
  static async start(install: FirefoxInstall, profilePath: string, { headless = false } = {}): Promise<RdpSession> {
    const profile = resolve(profilePath);
    if (profileInUse(profile)) throw new Error(`Firefox already has the profile at ${profile} open. Quit it first.`);
    const address = await claimServerAddress(install, profile);
    const child = launchFirefox(install, ["--start-debugger-server", serverArgument(address), "--profile", profile], { headless });
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
    let lastError = "its devtools server never came up";
    while (!failure && Date.now() < deadline) {
      let session: RdpSession;
      try {
        session = await RdpSession.connect(address);
      } catch (err) {
        lastError = (err as Error).message;
        await sleep(100);
        continue;
      }
      await session.waitForBrowserWindow(deadline);
      return session;
    }
    throw new Error(`Couldn't reach the devtools server of ${install.binary}: ${failure ?? lastError}`);
  }

  /**
   * Wait until Firefox has a browser window, or until `deadline`. Firefox
   * starts its devtools server before it opens its first window, and under load
   * an add-on installed in between starts with no window: a tabs.create in its
   * background, the usual welcome page, fails with "Not allowed to create tabs
   * on the target window" and no tab opens. A window with a tab is what the
   * devtools server lists as tabs.
   */
  async waitForBrowserWindow(deadline: number): Promise<void> {
    while (Date.now() < deadline) {
      const reply = await this.request("root", "listTabs").catch(() => undefined);
      if (reply && Array.isArray(reply.tabs) && reply.tabs.length > 0) return;
      await sleep(50);
    }
  }

  /**
   * Connect to the devtools server of the Firefox that has the profile open,
   * one that start() launched for an earlier run. Undefined when no Firefox has
   * the profile open, or the one that does runs no server.
   */
  static async attach(profilePath: string): Promise<RdpSession | undefined> {
    const profile = resolve(profilePath);
    if (!profileInUse(profile)) return undefined;
    const address = readServerFile(profile);
    if (!address) return undefined;
    return RdpSession.connect(address).catch(() => undefined);
  }

  /**
   * Install an add-on from an unpacked directory or an .xpi/.zip, temporarily:
   * no signature check, gone when Firefox quits. Firefox loads it in place, so
   * the files must stay put while Firefox runs. Returns the add-on ID.
   */
  async installTemporaryAddon(path: string): Promise<string> {
    const abs = resolve(path);
    if (!statSync(abs, { throwIfNoEntry: false })) throw new Error(`Nothing to install at ${abs}.`);
    if (this.addonsActor === undefined) {
      const root = await this.request("root", "getRoot");
      if (typeof root.addonsActor !== "string") throw new Error("This Firefox's devtools server can't install add-ons.");
      this.addonsActor = root.addonsActor;
    }
    let reply: Packet;
    try {
      reply = await this.request(this.addonsActor, "installTemporaryAddon", { addonPath: abs, openDevTools: false });
    } catch (err) {
      if (err instanceof RdpError) throw new Error(`Firefox refused the add-on at ${abs}: ${err.message}`);
      throw err;
    }
    const id = isObject(reply.addon) ? reply.addon.id : undefined;
    if (typeof id !== "string") throw new Error("Firefox installed the add-on but didn't report its ID.");
    return id;
  }

  /**
   * Keep events of `type` from now on, for takeEvent(). Firefox may send an
   * event ahead of the reply that announces it, so watch before the request.
   */
  watchEvents(type: string): void {
    if (!this.events.has(type)) this.events.set(type, []);
  }

  /** The first watched event of `type` that `match` accepts, kept or still to come. */
  takeEvent(type: string, match: (event: Packet) => boolean, timeoutMs = COMMAND_TIMEOUT_MS): Promise<Packet> {
    const kept = this.events.get(type);
    if (!kept) return Promise.reject(new Error(`Events of type ${type} aren't watched.`));
    const at = kept.findIndex(match);
    if (at >= 0) return Promise.resolve(kept.splice(at, 1)[0]);
    if (this.failure) return Promise.reject(this.failure);
    const { promise, resolve, reject } = Promise.withResolvers<Packet>();
    const waiter = {
      type,
      match,
      resolve,
      reject,
      timer: setTimeout(() => {
        this.eventWaiters.delete(waiter);
        reject(new Error(`Firefox sent no ${type} within ${timeoutMs / 1000} s.`));
      }, timeoutMs),
    };
    this.eventWaiters.add(waiter);
    return promise;
  }

  /** Disconnect. Firefox keeps running, and its devtools server keeps listening for the next run. */
  end(): void {
    this.fail(new Error("The connection to Firefox is closed."));
  }

  /** Send a request to an actor and wait for its reply. An error reply rejects with RdpError. */
  request(to: string, type: string, params: Packet = {}): Promise<Packet> {
    const send = (): Promise<Packet> => {
      if (this.failure) return Promise.reject(this.failure);
      const reply = this.expectReply(to, COMMAND_TIMEOUT_MS, `Firefox didn't answer ${type} within ${COMMAND_TIMEOUT_MS / 1000} s.`);
      // The length counts bytes, not characters.
      const json = JSON.stringify({ to, type, ...params });
      this.socket.write(`${Buffer.byteLength(json)}:${json}`);
      return reply;
    };
    const result = this.queue.then(send, send);
    this.queue = result.catch(() => {});
    return result;
  }

  private expectReply(actor: string, timeoutMs: number, timeoutMessage: string): Promise<Packet> {
    const { promise, resolve, reject } = Promise.withResolvers<Packet>();
    // A reply that comes after all would be taken for the next request's, so the connection goes.
    const timer = setTimeout(() => this.fail(new Error(timeoutMessage)), timeoutMs);
    this.pending = { actor, resolve, reject, timer };
    return promise;
  }

  private onData(chunk: Buffer): void {
    let packets: unknown[];
    try {
      packets = this.reader.push(chunk);
    } catch {
      this.fail(new Error(`What answers at ${this.where} isn't Firefox's devtools server.`));
      return;
    }
    for (const packet of packets) {
      if (!isObject(packet)) continue;
      // Events carry a type and replies don't. Only watched event types are kept.
      if ("type" in packet) {
        const kept = typeof packet.type === "string" ? this.events.get(packet.type) : undefined;
        if (!kept) continue;
        const waiter = [...this.eventWaiters].find((w) => w.type === packet.type && w.match(packet));
        if (waiter) {
          this.eventWaiters.delete(waiter);
          clearTimeout(waiter.timer);
          waiter.resolve(packet);
        } else {
          kept.push(packet);
        }
        continue;
      }
      const pending = this.pending;
      if (!pending || packet.from !== pending.actor) continue;
      this.pending = undefined;
      clearTimeout(pending.timer);
      if (typeof packet.error === "string") {
        pending.reject(new RdpError(typeof packet.message === "string" ? packet.message : packet.error));
      } else {
        pending.resolve(packet);
      }
    }
  }

  private fail(err: Error): void {
    if (this.failure) return;
    this.failure = err;
    const pending = this.pending;
    this.pending = undefined;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    for (const waiter of this.eventWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    this.eventWaiters.clear();
    this.socket.destroy();
  }
}
