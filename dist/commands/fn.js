import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { createHash } from "node:crypto";
import chalk from "chalk";
import { api, getBaseURL, getRequestToken, clientHeaders, APIError } from "../lib/api.js";
import { resolveProjectScope } from "../lib/resolve.js";
import { success, info, warn, fail, isJSONMode, printJSON, table } from "../lib/format.js";
export const DEFAULT_RUNTIME = {
    python: "python3.13", node: "nodejs22.x", ruby: "ruby3.3", go: "provided.al2023", rust: "provided.al2023", shell: "provided.al2023",
};
const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", "venv", "target", ".lizard", "dist-lizard"]);
/** What a file or directory is: language, files to send, handler, and whether it has a dependency file. */
export function detectSource(p, opts = {}) {
    let files = [];
    let entry;
    if (opts.stdin !== undefined) {
        entry = opts.stdinName || defaultFileFor(langOfRuntime(opts.runtime) ?? "python");
        files = [{ name: entry, data: Buffer.from(opts.stdin) }];
    }
    else {
        const st = fs.statSync(p);
        if (st.isDirectory()) {
            files = walk(p);
            entry = pickEntry(files.map((f) => f.name));
        }
        else {
            entry = path.basename(p);
            files = [{ name: entry, data: fs.readFileSync(p), mode: st.mode & 0o111 ? 0o100755 : undefined }];
            // A dependency file next to a single file is part of the function.
            for (const dep of ["requirements.txt", "package.json", "Gemfile", "go.mod", "go.sum"]) {
                const dp = path.join(path.dirname(p), dep);
                if (fs.existsSync(dp))
                    files.push({ name: dep, data: fs.readFileSync(dp) });
            }
        }
    }
    const names = files.map((f) => f.name);
    const lang = langOfRuntime(opts.runtime) ?? (names.includes("Cargo.toml") ? "rust" : names.includes("go.mod") || entry.endsWith(".go") ? "go"
        : /\.py$/.test(entry) ? "python" : /\.(m?js|cjs)$/.test(entry) ? "node" : /\.rb$/.test(entry) ? "ruby" : entry === "bootstrap" ? "shell"
            : /\.ts$/.test(entry) ? (fail("TypeScript: compile it to .js first (e.g. npx esbuild index.ts --bundle --platform=node --outfile=index.mjs), then deploy the .js", 2), "node")
                : (fail(`Can't tell the language of ${entry}: pass --runtime (e.g. python3.13, nodejs22.x, ruby3.3, provided.al2023)`, 2), "python"));
    const text = files.find((f) => f.name === entry)?.data.toString("utf8") ?? "";
    const handler = opts.handler ?? (lang === "go" || lang === "rust" || lang === "shell" ? "bootstrap" : findHandler(lang, entry, text));
    const deps = names.some((n) => ["requirements.txt", "Gemfile", "go.mod", "Cargo.toml"].includes(n))
        || (names.includes("package.json") && hasNodeDeps(files.find((f) => f.name === "package.json").data));
    return { lang, files, handler, entry, deps };
}
function langOfRuntime(rt) {
    if (!rt)
        return null;
    if (/^python/.test(rt))
        return "python";
    if (/^nodejs/.test(rt))
        return "node";
    if (/^ruby/.test(rt))
        return "ruby";
    if (rt === "go" || rt === "go1.x")
        return "go";
    if (rt === "rust")
        return "rust";
    if (/^provided/.test(rt))
        return null; // decided by the files
    return null;
}
const defaultFileFor = (l) => ({ python: "lambda_function.py", node: "index.mjs", ruby: "lambda_function.rb", go: "main.go", rust: "src/main.rs", shell: "bootstrap" }[l]);
function walk(root, rel = "") {
    const out = [];
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
            if (!SKIP_DIRS.has(e.name) && !e.name.startsWith("."))
                out.push(...walk(root, r));
            continue;
        }
        if (!e.isFile() || e.name === ".DS_Store")
            continue;
        const st = fs.statSync(path.join(root, r));
        out.push({ name: r, data: fs.readFileSync(path.join(root, r)), mode: st.mode & 0o111 ? 0o100755 : undefined });
    }
    const size = out.reduce((n, f) => n + f.data.length, 0);
    if (size > 50 * 1024 * 1024)
        fail(`${root} is ${Math.round(size / 1048576)} MB; a function's source is at most 50 MB (dependencies are installed by Lizard: don't ship node_modules or venv)`, 2);
    return out;
}
function pickEntry(names) {
    for (const n of ["Cargo.toml", "go.mod", "lambda_function.py", "handler.py", "app.py", "main.py", "index.mjs", "index.js", "handler.mjs", "handler.js", "app.js", "lambda_function.rb", "handler.rb", "bootstrap"]) {
        if (names.includes(n))
            return n === "Cargo.toml" ? "src/main.rs" : n === "go.mod" ? (names.find((x) => !x.includes("/") && x.endsWith(".go")) ?? "main.go") : n;
    }
    const top = names.filter((n) => !n.includes("/"));
    const guess = top.find((n) => /\.(py|m?js|cjs|rb|go)$/.test(n));
    if (!guess)
        fail("No function file found: name it handler.py, index.mjs, lambda_function.rb, main.go (or pass a file)", 2);
    return guess;
}
/** The handler (module.function) from the source, as Lambda names it. */
export function findHandler(lang, entry, text) {
    const mod = entry.replace(/\.(py|m?js|cjs|rb)$/, "");
    if (lang === "python") {
        const names = [...text.matchAll(/^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)/gm)].map((m) => m[1]);
        const fn = ["lambda_handler", "handler", "main"].find((n) => names.includes(n)) ?? names[0] ?? "lambda_handler";
        return `${mod}.${fn}`;
    }
    if (lang === "node") {
        const exported = [...text.matchAll(/export\s+(?:const|let|var|async\s+function|function)\s+([A-Za-z_$][\w$]*)/g), ...text.matchAll(/(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1]);
        const fn = ["handler", "lambdaHandler", "main"].find((n) => exported.includes(n)) ?? exported[0] ?? "handler";
        return `${mod}.${fn}`;
    }
    if (lang === "ruby") {
        const names = [...text.matchAll(/^def\s+([a-z_]\w*)/gm)].map((m) => m[1]);
        return `${mod}.${["lambda_handler", "handler"].find((n) => names.includes(n)) ?? names[0] ?? "lambda_handler"}`;
    }
    return "bootstrap";
}
function hasNodeDeps(pkg) {
    try {
        return Object.keys(JSON.parse(pkg.toString("utf8")).dependencies ?? {}).length > 0;
    }
    catch {
        return false;
    }
}
// ---------------- zip (no dependency) ----------------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++)
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
} return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++)
    c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
export function zipFiles(files) {
    const parts = [], central = [];
    let off = 0;
    for (const f of files) {
        const name = Buffer.from(f.name), comp = zlib.deflateRawSync(f.data), crc = crc32(f.data);
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0);
        lh.writeUInt16LE(20, 4);
        lh.writeUInt16LE(8, 8);
        lh.writeUInt16LE(0x21, 12);
        lh.writeUInt32LE(crc, 14);
        lh.writeUInt32LE(comp.length, 18);
        lh.writeUInt32LE(f.data.length, 22);
        lh.writeUInt16LE(name.length, 26);
        parts.push(lh, name, comp);
        const ch = Buffer.alloc(46);
        ch.writeUInt32LE(0x02014b50, 0);
        ch.writeUInt16LE(0x0314, 4);
        ch.writeUInt16LE(20, 6);
        ch.writeUInt16LE(8, 10);
        ch.writeUInt16LE(0x21, 14);
        ch.writeUInt32LE(crc, 16);
        ch.writeUInt32LE(comp.length, 20);
        ch.writeUInt32LE(f.data.length, 24);
        ch.writeUInt16LE(name.length, 28);
        ch.writeUInt32LE((((f.mode ?? (f.name === "bootstrap" ? 0o100755 : 0o100644)) << 16) >>> 0), 38);
        ch.writeUInt32LE(off, 42);
        central.push(ch, name);
        off += 30 + name.length + comp.length;
    }
    const cd = Buffer.concat(central), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(off, 16);
    return Buffer.concat([...parts, cd, end]);
}
const REGION_ALIASES = { us: "us-east-1", "us-east": "us-east-1", eu: "eu-west-lim-a", "eu-west": "eu-west-lim-a" };
async function regions() {
    const r = await api.get("/api/functions/regions").catch(() => null);
    const list = (Array.isArray(r) ? r : r?.regions ?? []).map((x) => (typeof x === "string" ? x : x.region ?? x.id)).filter(Boolean);
    return list.filter((x) => !x.startsWith("canary"));
}
async function resolveRegion(flag) {
    const all = await regions();
    if (!flag)
        return all.includes("us-east-1") ? "us-east-1" : all[0] ?? "us-east-1";
    const r = REGION_ALIASES[flag] ?? flag;
    if (all.length && !all.includes(r))
        fail(`Lizard Functions runs in ${all.join(", ")} (aliases: us, eu); not in ${flag}`, 2);
    return r;
}
async function accounts(projectId) {
    return api.get(`/api/functions/accounts?projectId=${encodeURIComponent(projectId)}`);
}
async function accountFor(projectId, region, create) {
    const a = (await accounts(projectId)).find((x) => x.region === region);
    if (a || !create)
        return a ?? null;
    return api.post("/api/functions/accounts", { projectId, region, withKey: false });
}
/** One AWS API call as the account, through the platform (no AWS keys on this machine). */
async function aws(acct, method, p, body, opts = {}) {
    const headers = { ...clientHeaders(), ...(opts.headers ?? {}) };
    const tok = getRequestToken();
    if (tok)
        headers.authorization = `Bearer ${tok}`;
    if (body !== undefined)
        headers["content-type"] = "application/json";
    if (opts.target)
        headers["x-lizard-target"] = opts.target;
    const res = await fetch(`${getBaseURL()}/api/functions/accounts/${acct.accountId}/aws/${p.replace(/^\//, "")}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(900_000),
    });
    const text = await res.text();
    let data = undefined;
    if (text) {
        try {
            data = JSON.parse(text);
        }
        catch {
            data = text;
        }
    }
    if (!res.ok) {
        const msg = (data && (data.message || data.Message || data.error)) || text || res.statusText;
        throw new APIError(res.status, String(msg), String(data?.__type ?? data?.Type ?? ""), data);
    }
    return { data, headers: res.headers, status: res.status };
}
const fnPath = (name) => `2015-03-31/functions/${encodeURIComponent(name)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getFn(acct, name) {
    try {
        return (await aws(acct, "GET", fnPath(name))).data;
    }
    catch (e) {
        if (e instanceof APIError && e.status === 404)
            return null;
        throw e;
    }
}
async function waitReady(acct, name, limitMs = 15 * 60_000, onTick) {
    const end = Date.now() + limitMs;
    for (;;) {
        const f = (await getFn(acct, name))?.Configuration;
        if (f) {
            onTick?.(f);
            if (f.State === "Failed")
                throw new Error(f.StateReason || "the function failed to start");
            if (f.LastUpdateStatus === "Failed")
                throw new Error(f.LastUpdateStatusReason || "the update failed");
            if (f.State === "Active" && f.LastUpdateStatus !== "InProgress")
                return f;
        }
        if (Date.now() > end)
            throw new Error("timed out waiting for the function");
        await sleep(400);
    }
}
async function waitBuild(acct, id, spinner) {
    const t0 = Date.now();
    for (;;) {
        const b = (await aws(acct, "GET", `lizard/builds/${id}`)).data;
        if (b.Status !== "InProgress")
            return b;
        spinner(`${b.Kind === "layer" ? "installing packages" : `building (${b.Language})`}… ${Math.round((Date.now() - t0) / 1000)}s`);
        await sleep(1000);
    }
}
function parseEnv(list) {
    if (!list?.length)
        return undefined;
    const out = {};
    for (const kv of list) {
        const i = kv.indexOf("=");
        if (i < 1)
            fail(`--env takes KEY=VALUE (got ${kv})`, 2);
        out[kv.slice(0, i)] = kv.slice(i + 1);
    }
    return out;
}
const splitList = (v) => (Array.isArray(v) ? v : v ? [v] : []).flatMap((x) => x.split(/[,\s]+/)).map((x) => x.trim()).filter(Boolean);
const DEBUG = !!process.env.LIZARD_DEBUG_FN;
let tStart = Date.now();
function status(msg) {
    if (DEBUG)
        process.stderr.write(`[${((Date.now() - tStart) / 1000).toFixed(2)}s] ${msg}\n`);
    if (!isJSONMode() && process.stderr.isTTY)
        process.stderr.write(`\r\x1b[2K${chalk.dim(msg)}`);
}
function statusDone() { if (!isJSONMode() && process.stderr.isTTY)
    process.stderr.write("\r\x1b[2K"); }
// ---------------- commands ----------------
export function registerFn(program) {
    const fn = program.command("fn").alias("functions")
        .description("Lizard Functions (AWS Lambda-compatible): deploy, invoke, logs")
        .addHelpText("after", `
Examples:
  lizard fn deploy handler.py --packages requests       # create or update, install, wait, done
  lizard fn deploy ./scraper --url                       # a directory (requirements.txt / package.json / go.mod / Cargo.toml)
  echo 'def handler(e, c): return e' | lizard fn deploy - --name echo --runtime python3.13
  lizard fn deploy main.go --schedule "rate(5 minutes)"  # Go and Rust are compiled on Lizard
  lizard fn invoke scraper '{"url": "https://example.com"}'
  lizard fn logs scraper --since 10m
  lizard fn ls
  eval "$(lizard fn env)"                                # AWS SDK / CLI credentials and endpoint`);
    fn.command("deploy")
        .description("Create or update a function from a file, a directory or stdin (-); installs packages, waits until it is ready")
        .argument("[path]", "file, directory or - for stdin", ".")
        .option("--name <name>", "function name (default: from the file or directory)")
        .option("--runtime <runtime>", "e.g. python3.13, nodejs22.x, ruby3.3, provided.al2023 (default: from the source)")
        .option("--handler <handler>", "e.g. app.handler (default: found in the source)")
        .option("--packages <list...>", "libraries to preinstall, e.g. requests numpy==2.1.3 (comma or space separated)")
        .option("--env <KEY=VALUE...>", "environment variables")
        .option("--memory <mb>", "memory in MB", (v) => parseInt(v, 10))
        .option("--timeout <seconds>", "timeout in seconds", (v) => parseInt(v, 10))
        .option("--url", "give it a public HTTPS URL")
        .option("--schedule <expression>", 'run it on a schedule: "rate(5 minutes)" or "cron(0 9 * * ? *)"')
        .option("--region <region>", "us-east-1 (us) or eu-west-lim-a (eu)")
        .option("--project <id>", "project (default: the linked one)")
        .action(async (p, o) => {
        const t0 = Date.now();
        tStart = t0;
        const stdin = p === "-" ? fs.readFileSync(0, "utf8") : undefined;
        if (p !== "-" && !fs.existsSync(p))
            fail(`${p} does not exist`, 2);
        if (stdin !== undefined && !o.name)
            fail("--name is required with stdin", 2);
        const src = detectSource(p, { runtime: o.runtime, handler: o.handler, stdin });
        const name = o.name ?? defaultName(p, src);
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(name))
            fail(`Function name ${name}: letters, numbers, hyphens and underscores, up to 64 (pass --name)`, 2);
        const runtime = o.runtime && !/^(go|rust)$/.test(o.runtime) ? o.runtime : DEFAULT_RUNTIME[src.lang];
        const packages = splitList(o.packages);
        const { projectId } = await resolveProjectScope(o.project);
        const region = await resolveRegion(o.region);
        status(`account in ${region}…`);
        const acct = (await accountFor(projectId, region, true));
        const zipBuf = zipFiles(src.files);
        const zip = zipBuf.toString("base64");
        const zipSha = createHash("sha256").update(zipBuf).digest("base64");
        const config = { Runtime: runtime, Handler: src.handler };
        if (o.memory)
            config.MemorySize = o.memory;
        if (o.timeout)
            config.Timeout = o.timeout;
        const env = parseEnv(o.env);
        if (env)
            config.Environment = { Variables: env };
        const existing = await getFn(acct, name);
        const compiled = src.lang === "go" || src.lang === "rust";
        let created = false;
        // Code: built on Lizard when it has a dependency file (or is Go / Rust), else sent as is.
        if (src.deps || compiled) {
            status(existing ? "building…" : "creating (building)…");
            if (existing)
                await waitReady(acct, name);
            if (existing)
                await aws(acct, "PUT", `${fnPath(name)}/configuration`, config);
            if (existing)
                await waitReady(acct, name);
            const job = (await aws(acct, "POST", `lizard/functions/${encodeURIComponent(name)}/build`, {
                ZipFile: zip, Runtime: runtime, ...(compiled && packages.length ? { Packages: packages } : {}),
                ...(existing ? {} : { Create: { Role: "arn:aws:iam::000000000000:role/lizard-function", MemorySize: 512, Timeout: 30, ...config } }),
            })).data;
            const b = await waitBuild(acct, job.BuildId, status);
            if (b.Status !== "Succeeded") {
                statusDone();
                fail(`Build failed: ${b.Error}\n${String(b.Log || "").slice(-3000)}`, 1, "BUILD_FAILED");
            }
            created = !existing;
        }
        else if (existing) {
            // Only what changed is sent: the same code (by SHA-256) and the same settings are no-ops.
            const c = existing.Configuration ?? {};
            if (c.LastUpdateStatus === "InProgress")
                await waitReady(acct, name);
            if (c.CodeSha256 !== zipSha) {
                status("updating code…");
                await aws(acct, "PUT", `${fnPath(name)}/code`, { ZipFile: zip });
            }
            const changed = Object.entries(config).some(([k, v]) => JSON.stringify(k === "Environment" ? { Variables: c.Environment?.Variables ?? {} } : c[k]) !== JSON.stringify(v));
            if (changed) {
                status("updating settings…");
                await waitReady(acct, name);
                await aws(acct, "PUT", `${fnPath(name)}/configuration`, config);
            }
        }
        else {
            status("creating…");
            await aws(acct, "POST", "2015-03-31/functions", { FunctionName: name, Role: "arn:aws:iam::000000000000:role/lizard-function", MemorySize: 512, Timeout: 30, ...config, Code: { ZipFile: zip } });
            created = true;
        }
        // Packages (Node.js / Python / Ruby): the function's own layer, rebuilt only when the list changes.
        let installed = null;
        if (!compiled) {
            await waitReady(acct, name, 15 * 60_000, (c) => status(c.State === "Pending" ? "preparing the runtime (the first one in a region takes up to a minute)…" : "updating…"));
            const cur = (await aws(acct, "GET", `lizard/functions/${encodeURIComponent(name)}/packages`)).data;
            const same = JSON.stringify([...(cur.Packages ?? [])].sort()) === JSON.stringify([...packages].sort());
            if (o.packages !== undefined && !same) {
                status("installing packages…");
                const job = (await aws(acct, "PUT", `lizard/functions/${encodeURIComponent(name)}/packages`, { Packages: packages })).data;
                if (job.BuildId) {
                    const b = await waitBuild(acct, job.BuildId, status);
                    if (b.Status !== "Succeeded") {
                        statusDone();
                        fail(`Installing packages failed: ${b.Error}\n${String(b.Log || "").slice(-3000)}`, 1, "BUILD_FAILED");
                    }
                }
            }
            installed = o.packages !== undefined ? packages : cur.Packages ?? [];
        }
        const cfg = await waitReady(acct, name, 15 * 60_000, (c) => status(c.State === "Pending" ? "preparing the runtime (the first one in a region takes up to a minute)…" : "starting…"));
        // URL and schedule.
        let url = null;
        if (o.url) {
            try {
                url = (await aws(acct, "GET", `2021-10-31/functions/${encodeURIComponent(name)}/url`)).data.FunctionUrl;
            }
            catch (e) {
                if (!(e instanceof APIError && e.status === 404))
                    throw e;
                url = (await aws(acct, "POST", `2021-10-31/functions/${encodeURIComponent(name)}/url`, { AuthType: "NONE", Cors: { AllowOrigins: ["*"] } })).data.FunctionUrl;
            }
        }
        if (o.schedule) {
            const body = { ScheduleExpression: o.schedule, FlexibleTimeWindow: { Mode: "OFF" }, Target: { Arn: cfg.FunctionArn, RoleArn: "arn:aws:iam::000000000000:role/lizard-scheduler" }, State: "ENABLED" };
            try {
                await aws(acct, "PUT", `schedules/${encodeURIComponent(name)}`, body);
            }
            catch (e) {
                if (e instanceof APIError && e.status === 404)
                    await aws(acct, "POST", `schedules/${encodeURIComponent(name)}`, body);
                else
                    throw e;
            }
        }
        statusDone();
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        const out = { name, region, created, runtime: cfg.Runtime, handler: cfg.Handler, language: src.lang, arn: cfg.FunctionArn, packages: installed, url, schedule: o.schedule ?? null,
            seconds: Number(secs), invoke: `lizard fn invoke ${name}${o.region ? ` --region ${region}` : ""} '{}'` };
        if (isJSONMode())
            return printJSON(out);
        success(`${created ? "Created" : "Updated"} ${chalk.bold(name)} in ${region} (${cfg.Runtime}, ${cfg.Handler}) in ${secs}s`);
        if (installed?.length)
            info(`Packages: ${installed.join(" ")}`);
        if (url)
            info(`URL: ${chalk.cyan(url)}`);
        if (o.schedule)
            info(`Schedule: ${o.schedule}`);
        info(`Call it: ${chalk.cyan(out.invoke)}`);
    });
    fn.command("invoke")
        .description("Call a function and print its result (and its log with --logs)")
        .argument("<name>")
        .argument("[event]", "event JSON (default {}; - reads stdin)", "{}")
        .option("--logs", "print the invocation's log")
        .option("--async", "queue it (InvocationType Event) and return at once")
        .option("--region <region>").option("--project <id>")
        .action(async (name, event, o) => {
        const acct = await existingAccount(o, name);
        const body = event === "-" ? fs.readFileSync(0, "utf8") : event;
        let parsed;
        try {
            parsed = JSON.parse(body);
        }
        catch {
            fail("The event must be JSON", 2);
        }
        const r = await aws(acct, "POST", `${fnPath(name)}/invocations`, parsed, { headers: { "x-amz-log-type": "Tail", ...(o.async ? { "x-amz-invocation-type": "Event" } : {}) } });
        const err = r.headers.get("x-amz-function-error");
        const tail = r.headers.get("x-amz-log-result");
        const logs = tail ? Buffer.from(tail, "base64").toString("utf8") : "";
        if (isJSONMode()) {
            if (err)
                process.exitCode = 1;
            return printJSON({ status: o.async ? "queued" : err ? "error" : "ok", error: err || undefined, result: r.data ?? null, logs: o.logs ? logs : undefined });
        }
        if (o.logs && logs)
            process.stderr.write(chalk.dim(logs.endsWith("\n") ? logs : logs + "\n"));
        if (o.async)
            return success("Queued");
        process.stdout.write((typeof r.data === "string" ? r.data : JSON.stringify(r.data ?? null, null, 2)) + "\n");
        if (err) {
            process.stderr.write(chalk.red(`Function error (${err})\n`));
            if (!o.logs && logs)
                process.stderr.write(chalk.dim(logs));
            process.exitCode = 1;
        }
    });
    fn.command("logs")
        .description("A function's logs (CloudWatch Logs format)")
        .argument("<name>")
        .option("--since <duration>", "e.g. 10m, 2h, 1d", "1h")
        .option("-f, --follow", "keep printing new lines")
        .option("--region <region>").option("--project <id>")
        .action(async (name, o) => {
        const acct = await existingAccount(o, name);
        let start = Date.now() - parseDuration(o.since);
        const seen = new Set();
        for (;;) {
            const r = await aws(acct, "POST", "", { logGroupName: `/aws/lambda/${name}`, startTime: start, limit: 1000 }, { target: "Logs_20140328.FilterLogEvents" }).catch((e) => {
                if (e instanceof APIError && (e.status === 400 || e.status === 404))
                    return { data: { events: [] } };
                throw e;
            });
            const events = (r.data.events ?? []).filter((e) => !seen.has(e.eventId ?? `${e.timestamp}${e.message}`));
            if (isJSONMode() && !o.follow)
                return printJSON(events);
            for (const e of events) {
                seen.add(e.eventId ?? `${e.timestamp}${e.message}`);
                if (isJSONMode())
                    printJSON(e);
                else
                    process.stdout.write(`${chalk.dim(new Date(e.timestamp).toISOString())} ${e.message}${String(e.message).endsWith("\n") ? "" : "\n"}`);
                start = Math.max(start, e.timestamp);
            }
            if (!o.follow)
                return;
            await sleep(2000);
        }
    });
    fn.command("ls").alias("list")
        .description("Functions of the project, in every region")
        .option("--project <id>")
        .action(async (o) => {
        const { projectId } = await resolveProjectScope(o.project);
        const rows = [];
        for (const a of await accounts(projectId)) {
            const r = await aws(a, "GET", "2015-03-31/functions/?MaxItems=200").catch(() => ({ data: { Functions: [] } }));
            for (const f of r.data.Functions ?? [])
                rows.push({ name: f.FunctionName, region: a.region, runtime: f.Runtime ?? f.PackageType, state: f.State ?? "Active", memory: f.MemorySize, modified: f.LastModified });
        }
        if (isJSONMode())
            return printJSON(rows);
        if (!rows.length)
            return info("No functions yet: lizard fn deploy handler.py");
        table(["NAME", "REGION", "RUNTIME", "STATE", "MEMORY", "MODIFIED"], rows.map((r) => [r.name, r.region, r.runtime, r.state, `${r.memory} MB`, String(r.modified).slice(0, 19)]));
    });
    fn.command("rm").alias("delete")
        .description("Delete a function (and its schedule)")
        .argument("<name>")
        .option("--region <region>").option("--project <id>")
        .action(async (name, o) => {
        const acct = await existingAccount(o, name);
        await aws(acct, "DELETE", `schedules/${encodeURIComponent(name)}`).catch(() => { });
        await aws(acct, "DELETE", fnPath(name));
        if (isJSONMode())
            return printJSON({ deleted: name, region: acct.region });
        success(`Deleted ${name} (${acct.region})`);
    });
    fn.command("env")
        .description("Print AWS credentials and endpoints for the project's functions (for the AWS SDKs / CLI): eval \"$(lizard fn env)\"")
        .option("--region <region>").option("--project <id>")
        .action(async (o) => {
        const { projectId } = await resolveProjectScope(o.project);
        const region = await resolveRegion(o.region);
        await accountFor(projectId, region, true);
        const k = await api.post(`/api/functions/projects/${encodeURIComponent(projectId)}/keys`);
        const ep = k.endpoints?.[region];
        if (isJSONMode())
            return printJSON({ AWS_ACCESS_KEY_ID: k.accessKeyId, AWS_SECRET_ACCESS_KEY: k.secretAccessKey, AWS_REGION: region, AWS_ENDPOINT_URL_LAMBDA: ep, endpoints: k.endpoints });
        process.stdout.write([`export AWS_ACCESS_KEY_ID=${k.accessKeyId}`, `export AWS_SECRET_ACCESS_KEY=${k.secretAccessKey}`, `export AWS_REGION=${region}`,
            `export AWS_ENDPOINT_URL_LAMBDA=${ep}`, `export AWS_ENDPOINT_URL_SQS=${ep}`, `export AWS_ENDPOINT_URL_SCHEDULER=${ep}`, `export AWS_ENDPOINT_URL_EVENTBRIDGE=${ep}`, `export AWS_ENDPOINT_URL_CLOUDWATCH_LOGS=${ep}`].join("\n") + "\n");
        if (process.stderr.isTTY)
            warn("A new access key was created (Access keys in the dashboard lists and deletes them).");
    });
}
function defaultName(p, src) {
    const base = p === "." ? path.basename(process.cwd()) : fs.existsSync(p) && fs.statSync(p).isDirectory() ? path.basename(path.resolve(p)) : path.basename(p).replace(/\.[^.]+$/, "");
    const n = (["handler", "lambda_function", "index", "main", "app", "bootstrap"].includes(base) ? path.basename(path.resolve(path.dirname(p === "." ? "./x" : p))) : base)
        .replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
    return n || `fn-${src.lang}`;
}
/** The region holding the function: --region, or the one region where it exists. */
async function existingAccount(o, name) {
    const { projectId } = await resolveProjectScope(o.project);
    const all = await accounts(projectId);
    if (o.region) {
        const region = await resolveRegion(o.region);
        const a = all.find((x) => x.region === region);
        if (!a)
            fail(`No functions in ${region} for this project`, 1, "NOT_FOUND");
        return a;
    }
    const holding = [];
    for (const a of all)
        if (await getFn(a, name).catch(() => null))
            holding.push(a);
    if (!holding.length)
        fail(`Function ${name} not found (lizard fn ls)`, 1, "NOT_FOUND");
    if (holding.length > 1)
        fail(`${name} exists in ${holding.map((a) => a.region).join(" and ")}: pass --region`, 2);
    return holding[0];
}
function parseDuration(s) {
    const m = String(s).match(/^(\d+)\s*(s|m|h|d)?$/);
    if (!m)
        fail(`--since takes e.g. 30s, 10m, 2h, 1d (got ${s})`, 2);
    return Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2] ?? "m"];
}
//# sourceMappingURL=fn.js.map