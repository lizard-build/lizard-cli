import { spawn } from "node:child_process";

// macOS tar otherwise creates AppleDouble ._* entries from file metadata.
export function createTarball(files: string[], cwd: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    // `--null` makes tar read NUL-separated paths from stdin, matching what
    // `git ls-files -z` writes. Newline-separated input would split filenames
    // containing `\n` across multiple entries. Both bsdtar (macOS) and GNU
    // tar accept `--null` before `-T -`.
    const tar = spawn("tar", ["--null", "-czf", "-", "-T", "-"], { cwd, env: { ...process.env, COPYFILE_DISABLE: "1" } });
    tar.on("error", reject);
    tar.stdin.on("error", reject);
    tar.stdout.on("data", (c: Buffer) => chunks.push(c));
    tar.stderr.on("data", () => {});
    tar.on("close", (code: number) => {
      if (code === 0) {
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const out = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) {
          out.set(c, off);
          off += c.length;
        }
        resolve(out);
      } else {
        reject(new Error(`tar exited ${code}`));
      }
    });
    if (files.length > 0) tar.stdin.write(files.join("\0") + "\0");
    tar.stdin.end();
  });
}

