import { createWriteStream, existsSync, renameSync, chmodSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
export const CURRENT_VERSION = "0.2.56";
const RELEASES_API = "https://api.github.com/repos/lizard-build/lizard-cli/releases/latest";
const RELEASE_BASE = "https://github.com/lizard-build/lizard-cli/releases/latest/download";
function getBinaryName() {
    const os = process.platform;
    const arch = process.arch;
    if (os === "darwin" && arch === "arm64")
        return "lizard-darwin-arm64";
    if (os === "darwin" && arch === "x64")
        return "lizard-darwin-x64";
    if (os === "linux" && arch === "x64")
        return "lizard-linux-x64";
    if (os === "linux" && arch === "arm64")
        return "lizard-linux-arm64";
    return null;
}
export async function getLatestVersion() {
    try {
        const res = await fetch(RELEASES_API, {
            headers: { "User-Agent": "lizard-cli" },
            signal: AbortSignal.timeout(5000),
        });
        if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
            const reset = Number(res.headers.get("x-ratelimit-reset"));
            return { kind: "rate-limited", resetAt: Number.isFinite(reset) ? reset : 0 };
        }
        if (!res.ok)
            return { kind: "error" };
        const data = (await res.json());
        const version = data.tag_name?.replace(/^v/, "");
        return version ? { kind: "ok", version } : { kind: "error" };
    }
    catch {
        return { kind: "error" };
    }
}
export async function selfUpdate(onProgress) {
    const binaryName = getBinaryName();
    if (!binaryName)
        return false;
    // Find current executable path
    const currentBin = process.execPath;
    if (!existsSync(currentBin))
        return false;
    const url = `${RELEASE_BASE}/${binaryName}`;
    const tmp = join(tmpdir(), `lizard-update-${Date.now()}`);
    onProgress?.(`Downloading ${binaryName}...`);
    const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!res.ok)
        throw new Error(`Download failed: ${res.status}`);
    const writer = createWriteStream(tmp);
    await pipeline(Readable.fromWeb(res.body), writer);
    chmodSync(tmp, 0o755);
    onProgress?.("Installing...");
    renameSync(tmp, currentBin);
    return true;
}
/** Run silently in background — checks for update and prints a notice after command finishes. */
export function checkForUpdateInBackground() {
    // Only check in TTY, not in CI or piped output
    if (!process.stdout.isTTY)
        return;
    const promise = getLatestVersion().then((r) => {
        if (r.kind !== "ok")
            return;
        const latest = r.version;
        if (latest === CURRENT_VERSION)
            return;
        // Compare semver simply
        const [maj, min, pat] = latest.split(".").map(Number);
        const [cmaj, cmin, cpat] = CURRENT_VERSION.split(".").map(Number);
        const isNewer = maj > cmaj || (maj === cmaj && min > cmin) || (maj === cmaj && min === cmin && pat > cpat);
        if (!isNewer)
            return;
        process.on("exit", () => {
            process.stderr.write(`\n  Update available: v${CURRENT_VERSION} → v${latest}\n  Run: lizard upgrade\n\n`);
        });
    }).catch(() => { });
    // Don't block process exit
    if (typeof promise.unref === "function")
        promise.unref();
}
//# sourceMappingURL=updater.js.map