import { createWriteStream, existsSync, renameSync, chmodSync, unlinkSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { join, dirname } from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

export const CURRENT_VERSION = "0.3.42";
const RELEASES_API = "https://api.github.com/repos/lizard-build/lizard-cli/releases/latest";
const RELEASE_BASE = "https://github.com/lizard-build/lizard-cli/releases/latest/download";

/** Minimum gap between background update checks. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

function getBinaryName(): string | null {
  const os = process.platform;
  const arch = process.arch;
  if (os === "darwin" && arch === "arm64") return "lizard-darwin-arm64";
  if (os === "darwin" && arch === "x64") return "lizard-darwin-x64";
  if (os === "linux" && arch === "x64") return "lizard-linux-x64";
  if (os === "linux" && arch === "arm64") return "lizard-linux-arm64";
  return null;
}

/**
 * True only when running as the Bun-compiled standalone binary. Under
 * npm/node, `process.execPath` is the *node* executable — self-update would
 * overwrite the user's Node.js install with the lizard binary.
 */
export function isStandaloneBinary(): boolean {
  return typeof (globalThis as any).Bun !== "undefined";
}

function stateDir(): string {
  return process.env.LIZARD_HOME
    ? join(process.env.LIZARD_HOME, ".lizard")
    : join(os.homedir(), ".lizard");
}
const checkStampFile = () => join(stateDir(), "update-check.json");
const updateNoticeFile = () => join(stateDir(), "update-notice.json");

export type LatestVersionResult =
  | { kind: "ok"; version: string }
  | { kind: "rate-limited"; resetAt: number }
  | { kind: "error" };

export async function getLatestVersion(): Promise<LatestVersionResult> {
  try {
    const res = await fetch(RELEASES_API, {
      headers: { "User-Agent": "lizard-cli" },
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      return { kind: "rate-limited", resetAt: Number.isFinite(reset) ? reset : 0 };
    }
    if (!res.ok) return { kind: "error" };
    const data = (await res.json()) as { tag_name?: string };
    const version = data.tag_name?.replace(/^v/, "");
    return version ? { kind: "ok", version } : { kind: "error" };
  } catch {
    return { kind: "error" };
  }
}

export function isNewerVersion(latest: string, current: string): boolean {
  const [maj, min, pat] = latest.split(".").map(Number);
  const [cmaj, cmin, cpat] = current.split(".").map(Number);
  if (![maj, min, pat, cmaj, cmin, cpat].every(Number.isFinite)) return false;
  return maj > cmaj || (maj === cmaj && min > cmin) || (maj === cmaj && min === cmin && pat > cpat);
}

export async function selfUpdate(onProgress?: (msg: string) => void): Promise<boolean> {
  const binaryName = getBinaryName();
  if (!binaryName) return false;

  // Refuse to replace anything that isn't the standalone lizard binary —
  // under npm the execPath is the user's node executable.
  if (!isStandaloneBinary()) return false;

  const currentBin = process.execPath;
  if (!existsSync(currentBin)) return false;

  const url = `${RELEASE_BASE}/${binaryName}`;
  // Download next to the target binary: rename() must stay on one filesystem
  // (tmpdir is often tmpfs on Linux → EXDEV).
  const tmp = join(dirname(currentBin), `.lizard-update-${process.pid}`);

  onProgress?.(`Downloading ${binaryName}...`);

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);

    const writer = createWriteStream(tmp);
    await pipeline(Readable.fromWeb(res.body as any), writer);
    chmodSync(tmp, 0o755);

    onProgress?.("Installing...");
    renameSync(tmp, currentBin);
    return true;
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
}

function readJSON(file: string): any {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJSON(file: string, data: unknown) {
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(file, JSON.stringify(data));
  } catch {}
}

function autoUpdateDisabled(): boolean {
  return Boolean(process.env.LIZARD_NO_UPDATE || process.env.CI);
}

/** Print (once) the notice left behind by a completed background update. */
function flushUpdateNotice(): void {
  const notice = readJSON(updateNoticeFile());
  if (!notice?.to) return;
  try { unlinkSync(updateNoticeFile()); } catch {}
  // We are already running the replaced binary, so notice.to should match.
  if (notice.to === CURRENT_VERSION && notice.from !== CURRENT_VERSION) {
    process.stderr.write(`  lizard auto-updated: v${notice.from} → v${notice.to}\n`);
  }
}

/**
 * Kick off an update check without delaying the current command.
 *
 * The check+download runs in a *detached child process* (`lizard
 * __lizard-update`): an in-process fetch would keep the event loop alive and
 * make every command linger until GitHub answers. Checks are throttled via a
 * stamp file (6h), disabled with LIZARD_NO_UPDATE/CI, and only run for the
 * standalone binary — npm installs upgrade through npm.
 */
export function checkForUpdateInBackground(): void {
  if (!process.stdout.isTTY) return;
  if (autoUpdateDisabled()) return;

  flushUpdateNotice();

  if (!isStandaloneBinary()) return;

  const stamp = readJSON(checkStampFile());
  if (stamp?.lastCheckAt && Date.now() - stamp.lastCheckAt < CHECK_INTERVAL_MS) return;
  // Stamp before spawning so parallel commands don't pile up children.
  writeJSON(checkStampFile(), { lastCheckAt: Date.now(), lastVersion: CURRENT_VERSION });

  try {
    const child = spawn(process.execPath, ["__lizard-update"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // never break the actual command over an update check
  }
}

/**
 * Body of the hidden `__lizard-update` command: check the latest release and
 * install it, leaving a notice file for the next foreground run.
 */
export async function runBackgroundUpdate(): Promise<void> {
  if (autoUpdateDisabled() || !isStandaloneBinary()) return;

  const r = await getLatestVersion();
  writeJSON(checkStampFile(), { lastCheckAt: Date.now(), lastVersion: r.kind === "ok" ? r.version : CURRENT_VERSION });
  if (r.kind !== "ok") return;
  if (!isNewerVersion(r.version, CURRENT_VERSION)) return;

  try {
    const ok = await selfUpdate();
    if (ok) {
      writeJSON(updateNoticeFile(), { from: CURRENT_VERSION, to: r.version, at: Date.now() });
    }
  } catch {
    // silent — retried after the next throttle window
  }
}
