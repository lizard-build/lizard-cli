import * as fs from "node:fs";
import * as path from "node:path";
import chalk from "chalk";
import { api, getBaseURL, withScope, APIError } from "../lib/api.js";
import { getToken } from "../lib/auth.js";
import { resolveProjectScope } from "../lib/resolve.js";
import { success, info, isJSONMode, printJSON, table, timeAgo } from "../lib/format.js";
/** Resolve the S3 addon to operate on: explicit --addon (name or id), or the
 *  project's single s3-type addon when there's exactly one. */
async function resolveS3AddonId(projectId, scope, addonFlag) {
    const data = await api.get(withScope(`/api/projects/${projectId}/services`, scope));
    const s3Addons = (data.addons ?? []).filter((a) => a.type === "s3");
    if (addonFlag) {
        const lower = addonFlag.toLowerCase();
        const match = s3Addons.find((a) => a.id.toLowerCase() === lower || a.name?.toLowerCase() === lower);
        if (!match) {
            throw new Error(`S3 addon "${addonFlag}" not found. Available: ${s3Addons.map((a) => a.name).join(", ") || "(none — run `lizard add s3` first)"}`);
        }
        return { id: match.id, name: match.name };
    }
    if (s3Addons.length === 0) {
        throw new Error('No S3 addon in this project. Run "lizard add s3" first.');
    }
    if (s3Addons.length > 1) {
        throw new Error(`Multiple S3 addons found: ${s3Addons.map((a) => a.name).join(", ")}. Pass --addon <name> to pick one.`);
    }
    return { id: s3Addons[0].id, name: s3Addons[0].name };
}
// Small extension → MIME map. Falls back to application/octet-stream, which
// is always a safe default for both storage and download behavior.
const MIME_TYPES = {
    ".html": "text/html",
    ".htm": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".mjs": "application/javascript",
    ".json": "application/json",
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".xml": "application/xml",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".zip": "application/zip",
    ".gz": "application/gzip",
    ".tar": "application/x-tar",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
};
function guessContentType(filePath) {
    return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}
function objectsUrl(projectId, addonId, bucket, key) {
    const encodedKey = key.split("/").map(encodeURIComponent).join("/");
    return `/api/projects/${projectId}/addons/${addonId}/s3/objects/${encodeURIComponent(bucket)}/${encodedKey}`;
}
async function uploadObject(params) {
    const url = getBaseURL() + objectsUrl(params.projectId, params.addonId, params.bucket, params.key);
    const res = await fetch(url, {
        method: "PUT",
        headers: {
            "Content-Type": params.contentType,
            Authorization: `Bearer ${getToken()}`,
        },
        body: params.body.buffer.slice(params.body.byteOffset, params.body.byteOffset + params.body.byteLength),
    });
    if (!res.ok) {
        const text = await res.text();
        let parsed = null;
        try {
            parsed = text ? JSON.parse(text) : null;
        }
        catch { }
        const detail = parsed?.error || parsed?.message || text || res.statusText;
        throw new APIError(res.status, `Upload failed (${res.status}): ${detail}`, parsed?.code || "", parsed);
    }
    return (await res.json());
}
export function registerS3(program) {
    const s3 = program.command("s3").description("Upload and manage objects in an S3 addon bucket");
    s3.command("upload")
        .description("Upload a local file to an S3 addon bucket")
        .argument("<file>", "Path to the local file to upload")
        .option("--addon <name>", "S3 addon name or ID (default: the project's only S3 addon)")
        .option("--bucket <name>", "Target bucket", "default")
        .option("--key <key>", "Destination object key (default: the file's base name)")
        .option("--content-type <type>", "Override the Content-Type header (default: guessed from extension)")
        .option("-p, --project <id>", "Project name, slug, or ID")
        .action(async (file, opts) => {
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
            throw new Error(`File not found: ${file}`);
        }
        const { projectId, scope } = await resolveProjectScope(opts.project);
        const addon = await resolveS3AddonId(projectId, scope, opts.addon);
        const key = opts.key || path.basename(file);
        const contentType = opts.contentType || guessContentType(file);
        const body = fs.readFileSync(file);
        if (!isJSONMode()) {
            info(`Uploading ${chalk.bold(file)} → ${chalk.cyan(`${addon.name}/${opts.bucket}/${key}`)}...`);
        }
        const result = await uploadObject({
            projectId,
            addonId: addon.id,
            bucket: opts.bucket,
            key,
            body,
            contentType,
        });
        if (isJSONMode()) {
            printJSON(result);
        }
        else {
            success(`Uploaded ${chalk.bold(key)} (${result.size} bytes)`);
            if (result.url) {
                info(`  URL: ${chalk.cyan(result.url)}`);
            }
            else {
                info(chalk.dim("  Bucket is not public-read — no direct URL. See the dashboard to flip ACL."));
            }
        }
    });
    s3.command("list")
        .alias("ls")
        .description("List objects in an S3 addon bucket")
        .option("--addon <name>", "S3 addon name or ID (default: the project's only S3 addon)")
        .option("--bucket <name>", "Bucket to list", "default")
        .option("--prefix <prefix>", "Only list keys under this prefix")
        .option("-p, --project <id>", "Project name, slug, or ID")
        .action(async (opts) => {
        const { projectId, scope } = await resolveProjectScope(opts.project);
        const addon = await resolveS3AddonId(projectId, scope, opts.addon);
        const qs = new URLSearchParams();
        if (opts.prefix)
            qs.set("prefix", opts.prefix);
        const path_ = `/api/projects/${projectId}/addons/${addon.id}/s3/buckets/${encodeURIComponent(opts.bucket)}/objects${qs.size ? "?" + qs.toString() : ""}`;
        const objects = await api.get(withScope(path_, scope));
        if (isJSONMode()) {
            printJSON(objects);
            return;
        }
        if (objects.length === 0) {
            info(chalk.dim("(empty)"));
            return;
        }
        table(["Key", "Size", "Modified"], objects.map((o) => [
            o.isPrefix ? chalk.cyan(o.key + "/") : o.key,
            o.isPrefix ? "" : `${o.size}`,
            o.lastModified ? timeAgo(o.lastModified) : "",
        ]));
    });
}
//# sourceMappingURL=s3.js.map