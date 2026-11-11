import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { cacheDir, readState, stateDir, writeState } from "../state.js";
import type { AmoCredentials, Issue } from "../types.js";
import { info, ok, warn } from "../util.js";
import { isAmoAddonId } from "./addon-id.js";
import { amoJwt } from "./jwt.js";

const AMO_BASE_URL = "https://addons.mozilla.org";

const UPLOAD_POLL_MS = 1000;
const VALIDATION_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_POLL_MS = 5000;
const DEFAULT_APPROVAL_TIMEOUT_MS = 15 * 60_000;
// Resubmissions after AMO answers "version already exists", on top of the first try.
const MAX_VERSION_RETRIES = 5;
// MV3 version components are at most nine digits.
const MAX_VERSION_COMPONENT = 999_999_999;
// Used when a 429 comes without a usable Retry-After.
const DEFAULT_RETRY_AFTER_SECONDS = 60;

// State files: every version submitted per add-on ID (AMO never takes one twice),
// submissions still waiting for a signature, and whether the policy notice was shown.
const VERSIONS_FILE = "amo-versions.json";
const PENDING_FILE = "amo-pending.json";
const NOTICE_FILE = "amo-notice-shown.json";
// Held while one of the files above is rewritten.
const STATE_LOCK = "amo-state.lock";
const LOCK_POLL_MS = 10;
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));

const POLICY_NOTICE =
  "AMO signs unlisted add-ons automatically, but they still fall under Mozilla's add-on policies: " +
  "obfuscated or minified code can be rejected, a signed add-on can be disabled later, and from " +
  "2026-12-01 Mozilla requires the source code for machine-generated or minified code. " +
  "https://extensionworkshop.com/documentation/publish/add-on-policies/";

const ADDON_VERSION_FIX = "Pass --addon-version <x.y.z.w> with a version this add-on has never used on AMO.";

// addons-linter (src/const.js MAX_FILE_SIZE_TO_PARSE_MB, src/linter.js scanFile)
// won't parse a file it reads as text from 5 MiB up and reports FILE_TOO_LARGE as
// a validation error, so AMO refuses to sign the package. It reads as text the
// files its HTML, JavaScript, JSON and language-pack scanners take; everything
// else (CSS, images, wasm) goes through its binary scanner, which has no limit.
const AMO_MAX_TEXT_FILE_BYTES = 5 * 1024 * 1024;
const AMO_TEXT_FILE_RE = /\.(html?|m?js|jsm|json|properties|ftl|dtd)$/i;

/**
 * The files in `dir` (a staged add-on) that AMO's validator refuses as too large to
 * parse, as warnings of category "amo". The amo route stops on them before
 * uploading, since AMO would reject the version.
 */
export function filesTooLargeForAmo(dir: string): Issue[] {
  const issues: Issue[] = [];
  const walk = (sub: string) => {
    for (const entry of readdirSync(join(dir, sub), { withFileTypes: true })) {
      const rel = sub ? `${sub}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(rel);
      else if (entry.isFile() && AMO_TEXT_FILE_RE.test(entry.name)) {
        const size = statSync(join(dir, rel)).size;
        if (size < AMO_MAX_TEXT_FILE_BYTES) continue;
        issues.push({
          severity: "warning",
          category: "amo",
          message: `${rel} is ${(size / 1024 / 1024).toFixed(1)} MiB; AMO's validator refuses text files of 5 MiB or more (FILE_TOO_LARGE), so AMO won't sign this add-on.`,
          file: rel,
          fix: "Split the file in the extension's own build (lavaduct doesn't), or install it with --sign unsigned or --sign temporary.",
        });
      }
    }
  };
  walk("");
  return issues;
}

export interface SignWithAmoOptions {
  addonId: string;
  /** Version from the converted manifest; bumped when AMO already has it. */
  baseVersion: string;
  credentials: AmoCredentials;
  /** Packs the staged add-on with `version` in its manifest. */
  pack: (version: string) => { xpiPath: string; sha256: string };
  /** Where the signed .xpi is written. */
  outDir: string;
  /** AMO site origin; addons.mozilla.org by default. */
  baseUrl?: string;
  /** How long to wait for the signature before giving up as pending (default 15 min). */
  approvalTimeoutMs?: number;
  /** Interval between signing status checks (default 5 s). */
  pollMs?: number;
}

export type AmoOutcome =
  | { kind: "signed"; signedXpiPath: string; version: string; cached: boolean }
  | { kind: "pending"; statusUrl: string; version: string }
  | { kind: "rejected"; issues: Issue[]; version?: string };

/** A version AMO accepted but hadn't signed yet when the run stopped waiting. */
interface PendingSubmission {
  addonId: string;
  /** SHA-256 of the add-on packed at its base version; identifies the input. */
  contentHash: string;
  version: string;
  versionId: number;
  statusUrl: string;
  submittedAt: string;
}

interface Amo {
  creds: AmoCredentials;
  baseUrl: string;
}

interface Timing {
  pollMs: number;
  timeoutMs: number;
}

type Upload = { kind: "valid"; uuid: string } | { kind: "refused"; issues: Issue[] };

type Submission =
  | { kind: "created"; versionId: number; statusUrl: string }
  | { kind: "version-used" }
  | { kind: "refused"; issues: Issue[] };

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

// AMO's errors are DRF payloads: {"detail": "..."} or field → [messages], sometimes nested.
function messagesOf(body: unknown): string[] {
  if (typeof body === "string") return [body];
  if (Array.isArray(body)) return body.flatMap(messagesOf);
  if (body !== null && typeof body === "object") return Object.values(body).flatMap(messagesOf);
  return [];
}

function errorDetail(status: number, body: unknown): string {
  return messagesOf(body).join(" ") || `HTTP ${status}`;
}

// A failed request, or a connection dropped mid-response (undici's bare "terminated"),
// named after the reason undici keeps on the error's cause.
function unreachable(url: string, err: unknown): Error {
  const cause = err instanceof Error ? err.cause : undefined;
  const reason =
    (cause instanceof Error && (cause.message || (cause as NodeJS.ErrnoException).code)) ||
    (err instanceof Error ? err.message : String(err));
  return new Error(`Couldn't reach AMO at ${new URL(url).origin}: ${reason}`);
}

async function readBytes(res: Response): Promise<Buffer> {
  try {
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    throw unreachable(res.url, err);
  }
}

async function readBody(res: Response): Promise<unknown> {
  const text = (await readBytes(res)).toString("utf-8");
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function amoIssue(message: string, fix?: string): Issue {
  return { severity: "error", category: "amo", message, ...(fix ? { fix } : {}) };
}

function rejected(message: string, fix: string | undefined, version?: string): AmoOutcome {
  return { kind: "rejected", issues: [amoIssue(message, fix)], ...(version ? { version } : {}) };
}

/**
 * One authenticated request, with a fresh token each time. A 429 is waited out for as
 * long as its Retry-After says and then retried; every other status is the caller's.
 */
async function amoFetch(
  amo: Amo,
  url: string,
  init: { method?: string; body?: string | FormData } = {},
): Promise<Response> {
  for (;;) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: init.method ?? "GET",
        body: init.body,
        headers: {
          Authorization: `JWT ${amoJwt(amo.creds.key, amo.creds.secret)}`,
          // AMO localizes its errors, and the version conflict is recognised by its wording.
          "Accept-Language": "en-US",
          ...(typeof init.body === "string" ? { "Content-Type": "application/json" } : {}),
        },
      });
    } catch (err) {
      throw unreachable(url, err);
    }
    if (res.status !== 429) return res;

    await readBytes(res);
    const header = res.headers.get("retry-after")?.trim() ?? "";
    const seconds = /^\d+$/.test(header) ? Number(header) : Math.ceil((Date.parse(header) - Date.now()) / 1000);
    const wait = Number.isFinite(seconds) ? Math.max(1, seconds) : DEFAULT_RETRY_AFTER_SECONDS;
    warn(`AMO's rate limit was reached; retrying in ${wait < 120 ? `${wait} s` : `${Math.ceil(wait / 60)} min`}.`);
    await sleep(wait * 1000);
  }
}

// The errors and warnings of an upload's linter run; notices are left out.
function validationIssues(validation: unknown): Issue[] {
  const messages = field(validation, "messages");
  if (!Array.isArray(messages)) return [];
  const issues: Issue[] = [];
  for (const m of messages) {
    const type = field(m, "type");
    const message = field(m, "message");
    if ((type !== "error" && type !== "warning") || typeof message !== "string") continue;
    const description = field(m, "description");
    const fix = (Array.isArray(description) ? description : [description])
      .filter((d) => typeof d === "string")
      .join(" ");
    const file = field(m, "file");
    const line = field(m, "line");
    issues.push({
      severity: type,
      category: "amo-validation",
      message,
      ...(typeof file === "string" && file ? { file } : {}),
      ...(typeof line === "number" ? { line } : {}),
      ...(fix ? { fix } : {}),
    });
  }
  return issues;
}

/** Upload the .xpi as unlisted and wait for AMO's linter to finish with it. */
async function uploadForValidation(amo: Amo, xpiPath: string): Promise<Upload> {
  const form = new FormData();
  form.append("channel", "unlisted");
  // AMO wants the file name to end in .xpi; the local name means nothing to it.
  form.append("upload", new Blob([readFileSync(xpiPath)], { type: "application/x-xpinstall" }), "addon.xpi");
  const res = await amoFetch(amo, `${amo.baseUrl}/api/v5/addons/upload/`, { method: "POST", body: form });
  let body = await readBody(res);
  if (res.status >= 400 && res.status < 500) {
    const fix =
      res.status === 401 ? "Check the AMO key and secret (--doctor tests them) and the system clock." : undefined;
    return { kind: "refused", issues: [amoIssue(`AMO refused the upload: ${errorDetail(res.status, body)}`, fix)] };
  }
  const uuid = field(body, "uuid");
  if (!res.ok || typeof uuid !== "string") {
    throw new Error(`AMO answered HTTP ${res.status} to the upload: ${errorDetail(res.status, body)}`);
  }

  const started = Date.now();
  while (field(body, "processed") !== true) {
    if (Date.now() - started > VALIDATION_TIMEOUT_MS) {
      throw new Error(
        `AMO hasn't finished validating the upload after ${VALIDATION_TIMEOUT_MS / 60_000} minutes. Try again later.`,
      );
    }
    await sleep(UPLOAD_POLL_MS);
    const poll = await amoFetch(amo, `${amo.baseUrl}/api/v5/addons/upload/${encodeURIComponent(uuid)}/`);
    body = await readBody(poll);
    if (!poll.ok) {
      throw new Error(`AMO answered HTTP ${poll.status} while validating the upload: ${errorDetail(poll.status, body)}`);
    }
  }

  const issues = validationIssues(field(body, "validation"));
  if (field(body, "valid") !== true) {
    if (!issues.some((i) => i.severity === "error")) issues.unshift(amoIssue("AMO's validation failed without saying why."));
    return { kind: "refused", issues };
  }
  // Warnings don't stop signing; show each distinct one once.
  const counts = new Map<string, number>();
  for (const i of issues) counts.set(i.message, (counts.get(i.message) ?? 0) + 1);
  for (const [message, n] of counts) warn(`AMO validation: ${message}${n > 1 ? ` (${n} places)` : ""}`);
  return { kind: "valid", uuid };
}

/** Create the add-on, or a new version of it, from a validated upload. */
async function submitVersion(amo: Amo, addonId: string, uuid: string): Promise<Submission> {
  const addonUrl = `${amo.baseUrl}/api/v5/addons/addon/${encodeURIComponent(addonId)}/`;
  const res = await amoFetch(amo, addonUrl, { method: "PUT", body: JSON.stringify({ version: { upload: uuid } }) });
  const body = await readBody(res);
  const messages = messagesOf(body);

  if (res.status === 200 || res.status === 201) {
    const version = field(body, "version");
    const versionId = field(version, "id");
    if (typeof versionId !== "number") {
      throw new Error("AMO accepted the submission but didn't say which version it created.");
    }
    const editUrl = field(version, "edit_url");
    const statusUrl = typeof editUrl === "string" ? editUrl : `${addonUrl}versions/${versionId}/`;
    return { kind: "created", versionId, statusUrl };
  }
  if (res.status === 409 && messages.some((m) => /already exists|uploaded before/i.test(m))) {
    return { kind: "version-used" };
  }
  // A 403 for an add-on Mozilla disabled says so in is_disabled_by_mozilla; the
  // permission message itself is the same as for someone else's ID.
  if (res.status === 403 && field(body, "is_disabled_by_mozilla") === true) {
    const message = `Mozilla disabled the add-on ${addonId} on AMO, so it takes no new versions.`;
    return { kind: "refused", issues: [amoIssue(message, "Pass --addon-id with a new ID to sign it as a separate add-on.")] };
  }
  if (res.status === 403) {
    const message = `The add-on ID ${addonId} belongs to another AMO account, so these credentials can't submit versions of it.`;
    const fix = "Use the credentials of the account that owns it, or pass --addon-id with a different ID.";
    return { kind: "refused", issues: [amoIssue(message, fix)] };
  }
  if (res.status === 409 && messages.some((m) => /duplicate add-on id/i.test(m))) {
    const message = `AMO won't take the add-on ID ${addonId}: an add-on that used it was deleted or blocked, and its ID can't be reused.`;
    return { kind: "refused", issues: [amoIssue(message, "Pass --addon-id with a new ID.")] };
  }
  if (res.status >= 400 && res.status < 500) {
    return { kind: "refused", issues: [amoIssue(`AMO refused the submission: ${errorDetail(res.status, body)}`)] };
  }
  throw new Error(`AMO answered HTTP ${res.status} to the submission: ${errorDetail(res.status, body)}`);
}

function signedCacheDir(addonId: string): string {
  return join(cacheDir(), "amo-signed", encodeURIComponent(addonId));
}

function readSignedCache(addonId: string, contentHash: string): { path: string; version: string } | undefined {
  const dir = signedCacheDir(addonId);
  const path = join(dir, `${contentHash}.xpi`);
  if (!existsSync(path)) return undefined;
  try {
    const version = field(JSON.parse(readFileSync(join(dir, `${contentHash}.json`), "utf-8")), "version");
    return typeof version === "string" ? { path, version } : undefined;
  } catch {
    return undefined;
  }
}

function writeSignedCache(addonId: string, contentHash: string, version: string, data: Buffer): void {
  const dir = signedCacheDir(addonId);
  mkdirSync(dir, { recursive: true });
  // The .xpi lands before its metadata, so a reader never finds metadata without the file.
  const metadata = JSON.stringify({ version, signedAt: new Date().toISOString() }, null, 2) + "\n";
  for (const [name, content] of [
    [`${contentHash}.xpi`, data],
    [`${contentHash}.json`, metadata],
  ] as const) {
    const tmp = join(dir, `${name}.${process.pid}.tmp`);
    writeFileSync(tmp, content);
    renameSync(tmp, join(dir, name));
  }
}

/** Drop the cached signed files of an add-on. Its version history stays: AMO never reuses a version. */
export function removeSignedCache(addonId: string): void {
  rmSync(signedCacheDir(addonId), { recursive: true, force: true });
}

/**
 * Run a read-modify-write of the AMO state files under a lock directory, so runs
 * signing at the same time don't overwrite each other's records: a lost pending
 * record makes the next run upload again, a lost version a 409 round trip. The
 * section takes milliseconds; a lock older than LOCK_STALE_MS was left by a run that
 * died holding it.
 */
function withStateLock<T>(update: () => T): T {
  mkdirSync(stateDir(), { recursive: true });
  const lock = join(stateDir(), STATE_LOCK);
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    let age = 0;
    try {
      age = Date.now() - statSync(lock).mtimeMs;
    } catch {
      continue;
    }
    if (age > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true });
    else Atomics.wait(LOCK_WAIT, 0, 0, LOCK_POLL_MS);
  }
  try {
    return update();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** Record that AMO has seen `version` of the add-on; returns every version recorded for it. */
function recordVersion(addonId: string, version: string): string[] {
  return withStateLock(() => {
    const all = readState<Record<string, string[]>>(VERSIONS_FILE, {});
    const versions = all[addonId] ?? [];
    if (!versions.includes(version)) all[addonId] = [...versions, version];
    writeState(VERSIONS_FILE, all);
    return all[addonId];
  });
}

function readPending(): PendingSubmission[] {
  const list = readState<PendingSubmission[]>(PENDING_FILE, []);
  return Array.isArray(list) ? list : [];
}

/** Replace the pending record for this add-on and input with `record`, or drop it. */
function setPending(addonId: string, contentHash: string, record?: PendingSubmission): void {
  withStateLock(() => {
    const others = readPending().filter((p) => p.addonId !== addonId || p.contentHash !== contentHash);
    writeState(PENDING_FILE, record ? [...others, record] : others);
  });
}

/**
 * Poll a submitted version until AMO signs it (then download it), rejects it, or the
 * timeout passes. Returns undefined when AMO no longer has the version.
 */
async function awaitSignature(
  amo: Amo,
  submission: PendingSubmission,
  signedXpiPath: string,
  timing: Timing,
): Promise<AmoOutcome | undefined> {
  const { addonId, contentHash, version, statusUrl } = submission;
  const url = `${amo.baseUrl}/api/v5/addons/addon/${encodeURIComponent(addonId)}/versions/${submission.versionId}/`;
  const deadline = Date.now() + timing.timeoutMs;
  for (let polls = 0; ; polls++) {
    const res = await amoFetch(amo, url);
    const body = await readBody(res);
    if (res.status === 404) {
      setPending(addonId, contentHash);
      return undefined;
    }
    if (!res.ok) {
      throw new Error(`AMO answered HTTP ${res.status} about version ${version}: ${errorDetail(res.status, body)}`);
    }

    const file = field(body, "file");
    const status = field(file, "status");
    if (status === "public") {
      const fileUrl = field(file, "url");
      if (typeof fileUrl !== "string") throw new Error(`AMO signed version ${version} but gave no download URL.`);
      // Unlisted files are only served to their developer, so the download needs the token too.
      const download = await amoFetch(amo, fileUrl);
      if (!download.ok) {
        throw new Error(`Couldn't download the signed version ${version} from AMO (HTTP ${download.status}).`);
      }
      const data = await readBytes(download);
      writeSignedCache(addonId, contentHash, version, data);
      mkdirSync(dirname(signedXpiPath), { recursive: true });
      writeFileSync(signedXpiPath, data);
      setPending(addonId, contentHash);
      ok(`AMO signed version ${version}`);
      return { kind: "signed", signedXpiPath, version, cached: false };
    }
    if (status === "disabled") {
      setPending(addonId, contentHash);
      return rejected(`AMO rejected version ${version} of ${addonId}.`, `See ${statusUrl} for the reason.`, version);
    }
    if (Date.now() + timing.pollMs > deadline) {
      warn(`AMO hasn't signed version ${version} yet. Follow it at ${statusUrl}; running the same conversion again picks it up.`);
      return { kind: "pending", statusUrl, version };
    }
    if (polls === 0) info(`Waiting for AMO to sign version ${version}`);
    await sleep(timing.pollMs);
  }
}

/**
 * The version to submit: `version` itself while AMO hasn't seen it, otherwise the same
 * version with a fourth component one past the highest recorded for it. Null when a
 * used `version` already has four components.
 */
export function bumpFourthComponent(version: string, used: string[]): string | null {
  if (!used.includes(version)) return version;
  const parts = version.split(".");
  if (parts.length >= 4) return null;
  const prefix = [...parts, "0", "0"].slice(0, 3).join(".");
  let highest = 0;
  for (const v of used) {
    const tail = v.startsWith(`${prefix}.`) ? v.slice(prefix.length + 1) : "";
    if (/^\d+$/.test(tail)) highest = Math.max(highest, Number(tail));
  }
  return highest < MAX_VERSION_COMPONENT ? `${prefix}.${highest + 1}` : null;
}

/**
 * Sign the add-on through AMO as an unlisted version. Unchanged contents come from the
 * signed cache without contacting AMO, a submission still waiting for its signature is
 * resumed instead of uploaded again, and a version AMO already has is bumped in its
 * fourth component. Throws when AMO can't be reached or fails on its side; a version
 * AMO accepted before that is picked up again by the next run.
 */
export async function signWithAmo(opts: SignWithAmoOptions): Promise<AmoOutcome> {
  const { addonId, baseVersion } = opts;
  const amo: Amo = { creds: opts.credentials, baseUrl: (opts.baseUrl ?? AMO_BASE_URL).replace(/\/+$/, "") };
  const timing: Timing = {
    pollMs: opts.pollMs ?? DEFAULT_POLL_MS,
    timeoutMs: opts.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
  };

  if (!readState<unknown>(NOTICE_FILE, null)) {
    warn(POLICY_NOTICE);
    writeState(NOTICE_FILE, { shownAt: new Date().toISOString() });
  }

  if (!isAmoAddonId(addonId)) {
    return rejected(
      `"${addonId}" isn't an add-on ID AMO accepts.`,
      `Use a {UUID} or an ID like name@example.com: at most 80 letters, digits, ".", "_" or "-" around one "@".`,
    );
  }

  let packed = opts.pack(baseVersion);
  const contentHash = packed.sha256;
  const signedXpiPath = join(opts.outDir, `${basename(packed.xpiPath).replace(/\.xpi$/i, "")}-signed.xpi`);

  const cached = readSignedCache(addonId, contentHash);
  if (cached) {
    mkdirSync(opts.outDir, { recursive: true });
    copyFileSync(cached.path, signedXpiPath);
    ok(`AMO already signed these contents as version ${cached.version}; using the cached file`);
    return { kind: "signed", signedXpiPath, version: cached.version, cached: true };
  }

  const pending = readPending().find((p) => p.addonId === addonId && p.contentHash === contentHash);
  if (pending) {
    info(`Resuming AMO signing of version ${pending.version}, submitted ${pending.submittedAt}`);
    const outcome = await awaitSignature(amo, pending, signedXpiPath, timing);
    if (outcome) return outcome;
    warn(`AMO no longer has version ${pending.version}; submitting the add-on again.`);
  }

  let version = bumpFourthComponent(baseVersion, readState<Record<string, string[]>>(VERSIONS_FILE, {})[addonId] ?? []);
  if (!version) {
    const message = `Version ${baseVersion} of ${addonId} was already submitted to AMO and has no fourth component left to bump.`;
    return rejected(message, ADDON_VERSION_FIX, baseVersion);
  }
  if (version !== baseVersion) {
    info(`Version ${baseVersion} was already submitted to AMO; using ${version}`);
    packed = opts.pack(version);
  }

  for (let retry = 0; ; retry++) {
    info(`Uploading version ${version} to AMO`);
    const upload = await uploadForValidation(amo, packed.xpiPath);
    if (upload.kind === "refused") return { kind: "rejected", issues: upload.issues, version };

    const submission = await submitVersion(amo, addonId, upload.uuid);
    if (submission.kind === "refused") return { kind: "rejected", issues: submission.issues, version };
    if (submission.kind === "version-used") {
      const used = recordVersion(addonId, version);
      if (retry === MAX_VERSION_RETRIES) {
        const message = `AMO refused ${retry + 1} versions of ${addonId} in a row as already used, the last one ${version}.`;
        return rejected(message, ADDON_VERSION_FIX, version);
      }
      const next = bumpFourthComponent(baseVersion, used);
      if (!next) {
        const message = `AMO already has version ${version} of ${addonId}, and it has no fourth component left to bump.`;
        return rejected(message, ADDON_VERSION_FIX, version);
      }
      info(`AMO already has version ${version}; retrying as ${next}`);
      version = next;
      packed = opts.pack(version);
      continue;
    }

    recordVersion(addonId, version);
    const record: PendingSubmission = {
      addonId,
      contentHash,
      version,
      versionId: submission.versionId,
      statusUrl: submission.statusUrl,
      submittedAt: new Date().toISOString(),
    };
    // Saved before waiting, so a run that dies while polling is picked up next time.
    setPending(addonId, contentHash, record);
    const outcome = await awaitSignature(amo, record, signedXpiPath, timing);
    return outcome ?? rejected(`AMO lost track of version ${version} right after accepting it.`, `Check ${record.statusUrl}.`, version);
  }
}

/** Check AMO credentials by fetching the account they belong to. Never throws. */
export async function checkAmoCredentials(
  creds: AmoCredentials,
  baseUrl = AMO_BASE_URL,
): Promise<{ ok: boolean; detail: string }> {
  const amo: Amo = { creds, baseUrl: baseUrl.replace(/\/+$/, "") };
  try {
    const res = await amoFetch(amo, `${amo.baseUrl}/api/v5/accounts/profile/`);
    const body = await readBody(res);
    if (!res.ok) return { ok: false, detail: `AMO refused the credentials: ${errorDetail(res.status, body)}` };
    const name = [field(body, "name"), field(body, "username")].find((v) => typeof v === "string" && v);
    return { ok: true, detail: `AMO account ${name ? `"${String(name)}"` : `#${String(field(body, "id"))}`}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
