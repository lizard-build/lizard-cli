import { createWriteStream, existsSync, renameSync, chmodSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export const CURRENT_VERSION = "0.1.10";
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

export async function getLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch(RELEASES_API, {
      headers: { "User-Agent": "lizard-cli" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { tag_name: string };
    return data.tag_name?.replace(/^v/, "") ?? null;
  } catch {
    return null;
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

/** Run silently in background — checks for update and prints a notice after command finishes. */
export function checkForUpdateInBackground(): void {
  // Only check in TTY, not in CI or piped output
  if (!process.stdout.isTTY) return;

  const promise = getLatestVersion().then((latest) => {
    if (!latest || latest === CURRENT_VERSION) return;
    // Compare semver simply
    const [maj, min, pat] = latest.split(".").map(Number);
    const [cmaj, cmin, cpat] = CURRENT_VERSION.split(".").map(Number);
    const isNewer = maj > cmaj || (maj === cmaj && min > cmin) || (maj === cmaj && min === cmin && pat > cpat);
    if (!isNewer) return;
    process.on("exit", () => {
      process.stderr.write(`\n  Update available: v${CURRENT_VERSION} → v${latest}\n  Run: lizard update\n\n`);
    });
  }).catch(() => {});

  // Don't block process exit
  if (typeof (promise as any).unref === "function") (promise as any).unref();
}
