import { createWriteStream, existsSync, renameSync, chmodSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export const CURRENT_VERSION = "0.3.5";
const RELEASES_API = "https://api.github.com/repos/lizard-build/lizard-cli/releases/latest";
const RELEASE_BASE = "https://github.com/lizard-build/lizard-cli/releases/latest/download";

function getBinaryName(): string | null {
  const os = process.platform;
  const arch = process.arch;
  if (os === "darwin" && arch === "arm64") return "lizard-darwin-arm64";
  if (os === "darwin" && arch === "x64") return "lizard-darwin-x64";
  if (os === "linux" && arch === "x64") return "lizard-linux-x64";
  if (os === "linux" && arch === "arm64") return "lizard-linux-arm64";
  return null;
}

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

export async function selfUpdate(onProgress?: (msg: string) => void): Promise<boolean> {
  const binaryName = getBinaryName();
  if (!binaryName) return false;

  // Find current executable path
  const currentBin = process.execPath;
  if (!existsSync(currentBin)) return false;

  const url = `${RELEASE_BASE}/${binaryName}`;
  const tmp = join(tmpdir(), `lizard-update-${Date.now()}`);

  onProgress?.(`Downloading ${binaryName}...`);

  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);

  const writer = createWriteStream(tmp);
  await pipeline(Readable.fromWeb(res.body as any), writer);
  chmodSync(tmp, 0o755);

  onProgress?.("Installing...");
  renameSync(tmp, currentBin);
  return true;
}

/** Check for a newer version and auto-install it in the background.
 *  Prints a one-line notice on exit — either "Updated to vX.Y.Z" or nothing on failure.
 *  Never blocks or crashes the current command. */
export function checkForUpdateInBackground(): void {
  // Only auto-update in TTY; skip CI / piped output
  if (!process.stdout.isTTY) return;

  let updateMessage: string | null = null;

  const promise = getLatestVersion().then(async (r) => {
    if (r.kind !== "ok") return;
    const latest = r.version;
    if (latest === CURRENT_VERSION) return;
    const [maj, min, pat] = latest.split(".").map(Number);
    const [cmaj, cmin, cpat] = CURRENT_VERSION.split(".").map(Number);
    const isNewer = maj > cmaj || (maj === cmaj && min > cmin) || (maj === cmaj && min === cmin && pat > cpat);
    if (!isNewer) return;
    try {
      process.stderr.write(`\n  Updating lizard v${CURRENT_VERSION} → v${latest}...\n`);
      const ok = await selfUpdate();
      if (ok) updateMessage = `  lizard updated to v${latest} — restart for the new version\n`;
    } catch {
      // silent — don't interrupt the current command
    }
  }).catch(() => {});

  process.on("exit", () => {
    if (updateMessage) process.stderr.write(updateMessage);
  });

  // Don't block process exit
  if (typeof (promise as any).unref === "function") (promise as any).unref();
}
