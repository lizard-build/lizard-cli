---
name: lizard-core
description: "Deploys and manages apps on Lizard with the `lizard` CLI: services from a repo or a local folder, managed databases (Postgres, Redis, S3-compatible storage), builds, secrets and environment variables, custom domains, logs, scaling and restarts, worker services, and billing. Use when the user asks to deploy, host or ship an app, agent, worker or database, mentions `lizard up`, `lizard add` or other deploy commands, or has a new repo with no chosen platform. For sandboxes, read `lizard skills get sandbox` instead."
argument-hint: "[optional natural-language request]"
allowed-tools: Bash(lizard:*), Bash(~/.lizard/bin/lizard:*), Bash(which:*), Bash(command:*), Bash(npm install:*)
---

# Lizard platform

Lizard is a unified cloud for apps, services, agents, and managed databases. All capabilities are exposed through the `lizard` CLI (npm package `@lizard-build/cli`). This skill teaches you to drive it. If `lizard` isn't on PATH, install it: `curl -fsSL https://lizard.build/install.sh | bash` on macOS and Linux (no Node.js or sudo needed; if `lizard` is still not found, call `~/.lizard/bin/lizard`), `irm https://lizard.build/api/cli/install.ps1 | iex` in Windows PowerShell, or `npm install -g @lizard-build/cli` anywhere. The install script ends by running `lizard login`, so its output may already hold the sign-in links: see [Sign-in](#sign-in).

This guide covers deploys: services, managed databases, builds, secrets and domains. **Sandboxes** (create, run code, files, ports, snapshots, desktop, coding agents, Lizard SDK) have their own guide: run `lizard skills get sandbox --json` for any sandbox task.

If `$ARGUMENTS` is non-empty, treat it as the user's request and act on it. If empty, ask what they want to do on Lizard.

## Read this first

This skill documents platform behavior (build pipeline, env precedence, what knobs the API exposes). It does not describe the user's repo.

Before writing commands for a specific project:

1. Read the user's `package.json`, `Dockerfile`, `requirements.txt`, framework config — confirm what already exists before adding flags.
2. Don't assume scripts/conventions that aren't visible. On the lizardpack auto-detect path, `Procfile` (`web:` line, Python/Ruby) and `package.json scripts.start` (Node) ARE picked up as the start command; on the synthesized-Dockerfile path (`buildCommand`/`startCommand` set) neither is read. Ports are inferred only from `EXPOSE`, framework defaults, or an explicit `PORT` env.
3. When in doubt, ask the user or run `lizard <cmd> --help --json`.

<!-- include: _shared/basics.md -->

## Deploy command output

For streaming commands (`lizard up` without `--detach`), `--json` produces one JSON event per line: `{ event: "log", line }`, terminating with `{ event: "done" }` / `{ event: "error", message }`; `up` additionally emits a final `{ event: "deployed" | "failed" | "deploying", status, url }` (`url` may be `null`). `lizard logs --json` is **not** a stream: it returns the last 200 lines (override with `--tail N`, max 1000) and exits — do not wait on it expecting more. Need a specific incident? Use `--restart latest` or `--restart <id>`. Only stream logs without `--json` if the user actively wants a live tail.

## Mental model

```
workspace → project → service (+ managed addons)
```

- Workspace — account/org level. User belongs to one or more.
- Project — group of related services in one workspace. The cwd gets linked to a project (config at `~/.lizard/config.json`).
- Service — a deployable unit. Source is either a git repo (`sourceType=github`) or an uploaded tarball (`sourceType=upload`).
- Managed addons — `postgres`, `redis`, `s3`. Provisioned with `lizard add <type>`; `s3` ships with a private bucket named `default`. See [Managed addons](#managed-addons) for the env vars each type exposes.
- Cross-resource refs — `${{<name>.<KEY>}}` resolves at deploy time against the target's merged env. A ref to a missing target or key resolves to an empty string and does NOT fail the deploy (only circular refs throw). After wiring refs, deploy and check `lizard logs --build --service <svc>`: the build log warns about every reference that came back empty. `lizard secrets list --service <svc> --show` shows what is stored. Refs match the target's current name, so renaming the target breaks them: update them after a rename.

## Setup decision flow

When the user wants to deploy or set up something new, work out the right action from cwd context before running anything:

1. `lizard status --json` in cwd.
2. Linked to a project? → add a service in that project: `lizard add -r owner/repo` (git source) or `lizard add -s <name>` (empty). Do not create a new project unless the user explicitly says so.
3. Not linked but parent dir is linked? → likely a monorepo sub-app. Add a service in the parent's project and set `rootDirectory` to the cwd subpath via `service set`.
4. Neither linked? → check `lizard project list --json` for one matching the directory or repo name. Match → `lizard link --project <name> [--workspace <ws>]` (pass `--workspace` to disambiguate same-named projects across workspaces). No match → `lizard up` deploys into the [default project](#default-project); run `lizard init --name <name>` first only when the user wants a separate project.

Naming heuristic: app-style names (`my-api`, `worker`, `flappy-bird`) are service names. Use the repo or directory name for the project.

## Platform builder

Builds run on the platform's build nodes (no local Docker needed). When a build fails, read logs with `lizard logs --build`.

### Build decision order

1. Repo Dockerfile (verbatim) — if `dockerfilePath` is set on the service, the platform builds that Dockerfile from the repo unchanged and ignores `buildCommand`/`startCommand` for the image. A set `startCommand` still replaces the image's CMD at run time.
2. Synthesized Dockerfile — if `buildCommand` and/or `startCommand` are set on the service (or passed via `lizard up`), the platform generates a Dockerfile from those commands. No lizardpack invocation.
3. lizardpack auto-detect — clone, run `lizardpack`. If a repo `Dockerfile` exists AND has a real build step (a `RUN <pkg-manager>` line, not just `COPY dist/`), it's used verbatim; otherwise lizardpack generates a multi-stage one. Supported: Go, Node, Python, Rust, Ruby, PHP, Java, static — first match in that order.

### What triggers a rebuild

- `git push` to the tracked branch → auto-rebuild via GitHub webhook.
- `lizard redeploy` / `lizard up` → explicit rebuild.
- Setting a `VITE_*` or `NEXT_PUBLIC_*` variable → the platform redeploys the running services that receive it, so the build bakes it in. Do NOT chain a `lizard redeploy`. See [Applying an env change](#applying-an-env-change) for which builds receive them.
- `service set` for build-affecting fields (`repoUrl`, `branch`, `sourceType`, `buildCommand`, `dockerfilePath`, `rootDirectory`) → auto-rebuilds running services. Do NOT chain a `lizard redeploy` after it — that queues a second, redundant build.
- `service set` for runtime-only fields (`startCommand`, `preDeployCommand`, `containerPort`, `watchPatterns`) → no auto-rebuild. Follow with `lizard redeploy` to apply.
- All other env vars / secrets → applied without a rebuild; the service restarts to pick them up.

## Deploying

First question for a new service: upload vs git repo. **Always check for a git remote before reaching for `up`** — the CLI never auto-detects one, so you must do it yourself:

```
git remote get-url origin
```

- **Exit 0 with a GitHub URL → use the git-source path below**, not `up`. Parse `owner/repo` from the URL and run `lizard add -r owner/repo`. This is strongly preferred: pushes auto-redeploy via webhook, and there's no re-upload on every change.
- **No remote / non-GitHub / not a git repo → use tarball upload (`lizard up`).** This is the fallback for quick local iteration or no-remote situations, not the default.

`lizard up` always works regardless of git state, which makes it the path of least resistance — resist it when a GitHub remote exists. Only fall back to upload when the remote check actually fails. (For a private repo whose remote exists but isn't yet accessible to Lizard, run `lizard git connect` to install the GitHub App, then use the git-source path — don't silently downgrade to a tarball.)

### Git-source deploy (preferred when there's a remote)

```
# One-shot for a new service from GitHub:
lizard add -r owner/repo --json

# Existing service: switch source to git or update branch:
lizard service set <svc> \
  --set sourceType=github \
  --set repoUrl=https://github.com/owner/repo \
  --set branch=main \
  --json
lizard redeploy --service <svc>
```

When `repoUrl` is set, pushes to the matching branch auto-redeploy via the GitHub webhook. If the service has a `rootDirectory` (monorepo subpath) or watch patterns, only matching changes trigger redeploys.

Useful `service set` fields (discover full list with `lizard service set --help --json`):

- `sourceType` = `github | upload`
- `repoUrl`, `branch`, `rootDirectory`
- `dockerfilePath` — use a specific repo Dockerfile, bypasses lizardpack auto-detect
- `buildCommand`
- `startCommand`, `preDeployCommand` — `preDeployCommand` runs before `startCommand` at the start of every container (each replica, each restart), and only when `startCommand` is also set. Make it safe to run many times and at the same time.
- `watchPatterns` — string array, comma-separated or JSON
- `containerPort` — TCP port the app listens on (defaults to 3000). Set to `0` for [worker mode](#worker-mode).
- `name` — rename a service (lowercase a-z, digits, hyphens; 1–40 chars). Goes through `config:apply`; the legacy `PATCH /api/apps/:id` returns 410. Refs to the old name (`${{old.KEY}}`) stop resolving: update them.

Field names are flat and match the wire schema 1:1 (and `service show` output). No `build.*` / `deploy.*` / `source.*` grouping exists in the API, DB, or node-agent.

`service set` uses optimistic concurrency via `configRevision`. On 409, re-read with `lizard service show`, reconcile, retry; `--force` overrides.

### Tarball upload (no git remote, or quick local iteration)

```
lizard up --json
```

- Uploads cwd as a tarball (respects `.gitignore`), forces `sourceType=upload`.
- Streams build logs over SSE; emits a final `{ event: "deployed", url }` on success (`{ event: "failed" }` on failure; `url` may be `null`).
- Flags: `--project`, `--service`, `--region`, `--build-command`, `--start-command`, `--pre-deploy-command`, `--port`, `--detach`, `--ci`.
- If cwd isn't linked and no `--project` is given, it links the folder to the [default project](#default-project) and deploys there as a new service. `--project <name>` uses that project, or creates it if none matches. It never creates a project from the folder name on its own.
- `lizard up` always switches the service to `sourceType=upload`. Do not use it to update a git-backed service — use `lizard redeploy` or push to the remote.

## Worker mode

For services that don't expose an HTTP listener (background workers, reconcilers, queue consumers, cron-style polling loops), set `containerPort=0`. The platform then:

- Skips `PORT` env injection (the worker doesn't bind anywhere).
- Skips the port reachability check (no `app port X unreachable` log spam, no false-positive "unhealthy" status).
- Skips `EXPOSE` in the synthesized Dockerfile.
- Skips the LB route registration on the node — nothing is served. (A generated `.onlizard.com` domain may still appear on the service; it won't respond.)

Set it one of three ways:

```
lizard up --port 0                              # new upload-source worker
lizard port 0 [--service <svc>]                 # flip existing service to worker mode
lizard service set <svc> --set containerPort=0  # same, via the config:apply path
```

`lizard port` with no argument prints the current port (or `worker mode` when 0). Worker mode is a hard switch — re-deploys are needed for the port change to take effect.

Don't use worker mode for a regular HTTP service that just happens to be slow to start — worker mode hides "the listener never came up" bugs because there's nothing to check.

## Secrets

Two scopes exist. No workspace-level globals.

- Project ("global"): `lizard secrets set KEY=v [K2=v2 …] --global` → project scope (wire: `secrets.shared`)
- Service (default): `lizard secrets set KEY=v [K2=v2 …] [--service <svc>]` → service scope (wire: `secrets.services[<svc>]`)

`set` is variadic. Companion subcommands: `lizard secrets list|delete K1 K2|import` (import reads dotenv from stdin). When the linked service in cwd is set, plain `lizard secrets set KEY=v` writes to that service. Pass `--global` to escape to project scope.

### Precedence (last writer wins)

```
addon-issued env  <  project secrets  <  project env  <  app env  <  app secrets  <  platform vars
```

App secrets override project secrets. Platform vars (`LIZARD_SERVICE_NAME`, `LIZARD_PROJECT_ID`, `PORT`, `LIZARD_PUBLIC_DOMAIN`, `LIZARD_PRIVATE_DOMAIN`) are last and cannot be shadowed. Addon-issued env is every running Postgres and Redis addon's `DATABASE_URL` / `REDIS_URL`, injected into every service in the project.

### Secret scoping

Default to service-scope. `--global` puts the value into `process.env` of every service in the project — including ones that don't need it.

Rules:

- Check first: `lizard secrets list` (+ `--global`) before set/update — avoid creating a duplicate or shadowing an existing key (service scope wins over global; see [Precedence](#precedence-last-writer-wins)).
- Default — service-scope: `lizard secrets set KEY=v --service <svc>` per consumer. For addon DSNs, prefer a private reference when the consumer can reach it: `lizard secrets set DATABASE_URL='${{postgres.DATABASE_PRIVATE_URL}}' --service <svc>` (no separate `env` command — refs are interpolated at deploy time wherever they appear). A ref reads the addon's current value on each deploy of the consumer; there is no automatic credential rotation.
- `--global` only for non-secrets and provably-public values: `LOG_LEVEL`, `NODE_ENV`, feature flags, frontend `SENTRY_DSN`. If unsure whether a value is a secret, treat it as one. A compromised service reads its own env; broader scope = more credentials exposed for no reason.

### Applying an env change

- Runtime vars/secrets apply without rebuilding the image. The application process restarts to read its new environment; do not promise uninterrupted requests.
- `VITE_*` / `NEXT_PUBLIC_*` (build-time baked) → setting one redeploys the running services that receive it; a plain restart won't pick them up. Only a Dockerfile the platform generates bakes them in: lizardpack on a GitHub service, or a service with `buildCommand`/`startCommand`. A `dockerfilePath` build, or a `lizard up` upload without those overrides, gets no Lizard variables at build time, and no build gets build args except `COMMIT_SHA`. For public values there, commit them in `.env.production`, set a build command, or write them into the Dockerfile.
- Verify a non-secret value or the application's behavior. Do not print the full environment: it can expose credentials.

## Managed addons

Provision with `lizard add <type>`. Each addon exposes a fixed env-var set; reference by name from a consumer service via `${{<addon-name>.KEY}}`. The first addon of a given type gets the bare type as its name (so use `postgres` in the reference for the first Managed Postgres instance); subsequent ones get `{type}-{adjective}-{noun}` like `postgres-autumn-bear`. There's no type-alias fallback — a ref must use the addon's actual name. Refs match the addon's current name, so renaming it breaks existing refs: update them after a rename. Every running Postgres and Redis addon's `DATABASE_URL` / `REDIS_URL` also reaches every service in the project at the lowest precedence; a value set on the consumer overrides it.

- `postgres` — two connection URLs: prefer `DATABASE_PRIVATE_URL` when available and reachable within the same project and region (no ingress/egress charges); use `DATABASE_URL` for public access, such as local clients or external CI (network charges may apply). Also exposes `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `POSTGRES_USER`, `POSTGRES_DB`, `POSTGRES_PASSWORD`.
- `redis` — `REDIS_URL`; services in the same project should use `REDIS_PRIVATE_URL`. No eviction policy and no append-only file are configured: if it runs out of memory, the instance restarts and recent writes can be lost. Keep data you cannot lose in Postgres.
- `s3` — `S3_ENDPOINT`, `S3_DEFAULT_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`. Auto-creates a private bucket named `default`, and each account can store up to 16 GiB across its addons. Make a bucket public from the dashboard's S3 browser; objects in a public bucket are served without auth two ways: the gateway URL the dashboard shows, `https://s3-<region>.onlizard.com/<addonId>/<bucket>/<key>`, or the platform proxy `<dashboard-host>/api/s3/<addonId>/public/<bucket>/<key>` (the host `lizard open` launches; long-lived immutable cache headers). For AWS SDK use, set `forcePathStyle: true`. ACL flips aren't on the CLI yet, so point users at the dashboard. To push a local file into a bucket directly (no AWS SDK needed), use `lizard s3 upload <file> [--addon <name>] [--bucket <name>] [--key <key>] [--content-type <type>]` — auto-resolves the project's only S3 addon and bucket `default` if omitted; prints `{key, etag, size, url}` (`url` is `null` unless the bucket is public). `lizard s3 list|ls [--bucket <name>] [--prefix <p>]` lists objects in a bucket.

## Composition patterns

Multi-step requests follow natural chains. Return one unified response, don't farm out steps:

- First deploy from git — pick action via [Setup decision flow](#setup-decision-flow) → `lizard add -r owner/repo` → stream build → surface URL.
- First deploy from local code — Setup decision flow → `lizard up` → surface URL.
- Add a managed database to an existing service — `lizard add postgres` → bind the consumer's `DATABASE_URL` to the private reference as described above (the service restarts with it; no redeploy needed).
- Add object storage to a service — `lizard add s3` → reference `${{s3.S3_ENDPOINT}}`, `${{s3.S3_DEFAULT_BUCKET}}`, `${{s3.S3_ACCESS_KEY_ID}}`, `${{s3.S3_SECRET_ACCESS_KEY}}`, `${{s3.S3_REGION}}` from the consumer service. The `default` bucket is private; to serve files without auth, have the user make it public in the dashboard's S3 browser, then objects are served at `<dashboard-host>/api/s3/<addonId>/public/default/<key>`. See [Managed addons](#managed-addons).
- Wire a fresh git source on an existing service — `service set --set sourceType=github --set repoUrl=… --set branch=…` → `redeploy`.
- Fix a failed build — `logs --build` → diagnose → fix project (user's repo) OR adjust `buildCommand` / `startCommand` via `service set` → `redeploy` → `logs` to verify.
- Add a custom domain — `domain <host> --service <svc>` (the hostname is a positional, there is no `add` subcommand) → surface the TXT/CNAME records to the user → `domain verify <host>` once DNS propagates. Bare `domain` shows (or auto-generates) the service's current domain. If the host is already attached to another of the user's services, the attach 409s with a reclaim hint — re-run with `--force` to move it here.

## Common ops

```
lizard logs --json [--service <name>]      # last 200 runtime log lines, then exit (--tail N to override)
lizard logs --build --json                  # last build's logs
lizard logs --restart latest --json         # log tail of the most recent crash/restart
lizard ps --json                            # services with status + URL (per-replica detail: `events`)
lizard status                               # cwd project link (no auth needed)
lizard restart --service <name>             # rolling restart
lizard redeploy [--service <name>]          # rebuild + redeploy from current source
lizard scale --service <name> --replicas N
lizard domain example.com --service <name>  # attach custom domain (positional, not `domain add`)
lizard domain --json                        # show/auto-generate the service's current domain
lizard domain verify example.com            # activate after DNS records propagate
lizard domain example.com --service <name> --force  # move domain here from another of your services
lizard metrics --json                       # CPU/memory/network/disk (add --cost for cost)
lizard billing --json                       # plan, trial, usage this month, Billing link
lizard metrics --all --json                 # all services in the project, even from a service-linked directory
lizard metrics --all --watch                # live overview of all services in the project
lizard events --json                        # deploy history + replica status
lizard ssh --service <name> -- <cmd>        # DISABLED for services: the API answers 403 "Shell access to services is disabled" (sandboxes: `lizard sandbox ssh`)
lizard run --service <name> -- <cmd>        # run a command LOCALLY with the service's stored secrets (an addon gives its real connection values)
lizard project list --json                  # all projects in workspace
lizard regions --json
lizard open                                 # open dashboard
lizard whoami --json                        # auth check
lizard s3 upload <file> [--bucket <b>]      # upload a local file to an S3 addon bucket
lizard s3 list --json [--bucket <b>]        # list objects in an S3 addon bucket
```

`lizard metrics --all` ignores the directory's linked service for this command.
It uses the linked project unless `--project <name>` selects another project.
Without `--all`, metrics defaults to the linked service, or the project overview
when no service is linked. Do not combine `--all` with `--service`.
The project overview includes `Egress` (outbound bytes per second) and `Volumes`
(used / total bytes). These columns use the latest sample from the past hour;
`Sampled` refers to CPU and memory. Missing measurements show `—`.
Watch mode refreshes CPU and memory every 3 seconds and I/O history every 30 seconds.
JSON output includes the history in each service's `series` and `timestamps` fields.

`lizard run --service <app>` injects stored values only: `${{…}}` refs arrive as literal text, and platform vars (`PORT`, `LIZARD_*`) are not set. `--service <addon>` injects the addon's real connection values, so use it to run a local command against a database. To check a service's wiring, use `lizard logs --build --service <svc>` and `lizard secrets list --service <svc> --show`; shell access into services is off.

For exact flags, `lizard <cmd> --help --json`. Other commands not shown above: `lizard git` (GitHub integration), `lizard config` (project configuration), `lizard workspace` (workspace info) — discover each with `lizard <cmd> --help --json`.

## Response format

After an operation, return:

1. What was done — action + scope (which project, which service).
2. Result — IDs, status, URLs from the JSON output.
3. What's next — verifying read-back command, DNS record the user must add, env-var reference template, or confirmation the task is complete.

Skip command-by-command transcripts unless they explain a failure.

## Don't do

1. Don't add Docker `HEALTHCHECK` — the platform ignores it (it doesn't run Docker's healthcheck loop).
2. On the lizardpack auto-detect path, `Procfile` (`web:`) and `package.json scripts.start` are picked up automatically — don't force a redundant `startCommand`. But the moment `buildCommand`/`startCommand` is set (synthesized-Dockerfile path), neither is read — there set `startCommand` explicitly via `lizard up --start-command` / `service set --set startCommand=...`, or include `CMD` in the user's Dockerfile.
3. Don't use `lizard up` to switch a service to a git source. It always forces `sourceType=upload`. Use `service set` + `redeploy` instead.
4. A Dockerfile that copies pre-built artifacts (`COPY dist/`, `build/`, `out/`, `.next/`, `public/`) without a `RUN` build step gets silently regenerated by lizardpack. Add a build step or set `dockerfilePath` to force verbatim use.
5. Don't generate Dockerfiles unsolicited — lizardpack auto-detects most stacks. Try a deploy first; write one only if it fails. Ask before either.
6. Don't put runtime secrets (DB credentials, API keys, RPC creds, S3 keys) in `--global` "just in case another service needs it later". Scope to the services that consume them — see [Secret scoping](#secret-scoping).
