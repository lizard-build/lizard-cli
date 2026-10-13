# Deploys in depth

The details behind the deploy, database and secrets sections of the core guide: how builds are chosen, git and upload deploys, service fields, worker mode, secret precedence and references, addon variables, and multi-step recipes.

## Contents

- [Before you deploy](#before-you-deploy)
- [Platform builder](#platform-builder)
- [Deploying](#deploying)
- [Worker mode](#worker-mode)
- [Secrets](#secrets)
- [Managed addons](#managed-addons)
- [Composition patterns](#composition-patterns)
- [Logs, metrics and lizard run](#logs-metrics-and-lizard-run)

## Before you deploy

This skill documents platform behavior (build pipeline, env precedence, what knobs the API exposes). It does not describe the user's repo.

Before writing commands for a specific project:

1. Read the user's `package.json`, `Dockerfile`, `requirements.txt`, framework config — confirm what already exists before adding flags.
2. Don't assume scripts/conventions that aren't visible. On the lizardpack auto-detect path, `Procfile` (`web:` line, Python/Ruby) and `package.json scripts.start` (Node) ARE picked up as the start command; on the synthesized-Dockerfile path (`buildCommand`/`startCommand` set) neither is read.
3. Ports: `lizard up` fixes a new service's port from `--port`, else the folder's Dockerfile `EXPOSE`, else 3000, and the app must listen there (`$PORT`). lizardpack's Python commands bind 8000 and PHP 80: pass `--port 8000` / `--port 80`, or a start command that reads `$PORT`. Git services take the port from the image's `EXPOSE` unless `containerPort` or a `PORT` variable is set. Nothing reads the port from logs.
4. When in doubt, ask the user or run `lizard <cmd> --help --json`.

## Platform builder

Builds run on the platform's build nodes (no local Docker needed). When a build fails, read logs with `lizard logs --build`.

### Build decision order

1. Repo Dockerfile (verbatim) — if `dockerfilePath` (relative to `rootDirectory`) is set, the platform builds that Dockerfile unchanged and ignores `buildCommand`/`startCommand` for the image. A set `startCommand` still replaces the image's ENTRYPOINT and CMD at run time (`sh -c`, so the image needs `sh`).
2. Synthesized Dockerfile — if `buildCommand` and/or `startCommand` are set (on the service or via `lizard up`), the platform generates a Go, Python or Node Dockerfile, chosen by the command's first word (anything else gets Node). It replaces the repo Dockerfile and lizardpack, so on other stacks fix the start through a Dockerfile, not `startCommand`.
3. Root `Dockerfile` — used as is for uploads. For git, used unless it has no install or build `RUN` (`npm|yarn|pnpm|bun|pip|bundle|cargo|go build|mvn|gradle`) and copies a build folder (`COPY dist ...`, `build`, `out`, `.next`, `public`): then lizardpack replaces it and the build log says so.
4. lizardpack auto-detect — Hugo, Go, Node, Python, Rust, Ruby, PHP, Java, static, first match wins. When nothing matches, the image runs `bash start.sh`, which builds but fails to start.

### What triggers a rebuild

- `git push` to the tracked branch → auto-rebuild, when the Lizard GitHub App covers the repo (`lizard git status --json`).
- `lizard redeploy` / `lizard up` → explicit rebuild.
- Setting a `VITE_*` or `NEXT_PUBLIC_*` variable → the platform redeploys the running services that receive it, so the build bakes it in. Do NOT chain a `lizard redeploy`. See [Applying an env change](#applying-an-env-change) for which builds receive them.
- `service set` for build-affecting fields (`repoUrl`, `branch`, `sourceType`, `buildCommand`, `dockerfilePath`, `rootDirectory`) → auto-rebuilds a service whose status is `running`. Do NOT chain a `lizard redeploy` after it — that queues a second build. A service that never came up, crashed or stopped doesn't rebuild: run `lizard redeploy`.
- `service set` for runtime-only fields (`startCommand`, `preDeployCommand`, `containerPort`, `watchPatterns`) → no auto-rebuild. Follow with `lizard redeploy` to apply.
- All other env vars / secrets → applied without a rebuild; the service restarts to pick them up.

## Deploying

First question for a new service: upload vs git repo. **Always check for a git remote before reaching for `up`** — the CLI never auto-detects one, so you must do it yourself:

```
git remote get-url origin
```

- **Exit 0 with a GitHub URL → use the git-source path below**, not `up`. Parse `owner/repo` from the URL and run `lizard add -r owner/repo -n <svc>`. This is strongly preferred: pushes redeploy (with the Lizard GitHub App), and there's no re-upload on every change.
- **No remote / non-GitHub / not a git repo → use tarball upload (`lizard up`).** This is the fallback for quick local iteration or no-remote situations, not the default.

`lizard up` always works regardless of git state, which makes it the path of least resistance — resist it when a GitHub remote exists. Only fall back to upload when the remote check actually fails. (For a private repo whose remote exists but isn't yet accessible to Lizard, run `lizard git connect` to install the GitHub App, then use the git-source path — don't silently downgrade to a tarball.)

### Git-source deploy (preferred when there's a remote)

```
# One-shot for a new service from GitHub (tracks main):
lizard add -r owner/repo -n <svc> --json

# Another branch:
lizard add -r owner/repo -n <svc> --no-deploy --json
lizard service set <svc> --set branch=<branch> --json
lizard redeploy --service <svc> --wait --json

# Existing service: switch source to git (rebuilds by itself when the service is running;
# otherwise follow with `lizard redeploy --service <svc>`):
lizard service set <svc> \
  --set sourceType=github \
  --set repoUrl=https://github.com/owner/repo \
  --set branch=main \
  --json
```

`add -r` with a name that already exists overwrites that service (branch back to `main`, commands cleared) and redeploys it: pick a new `-n`. A private repo Lizard can't read answers 404 `Repository not found`: `lizard git connect --json` gives an `installUrl` for the user. When `repoUrl` is set, pushes to the branch redeploy through the Lizard GitHub App. With a `rootDirectory` or watch patterns, only pushes touching either one redeploy; `autoDeploy=false` turns pushes off.

Useful `service set` fields (the full list is in the plain `lizard service set --help`; the JSON schema leaves it out):

- `sourceType` = `github | upload`
- `repoUrl`, `branch`, `rootDirectory`
- `dockerfilePath` — use a specific repo Dockerfile, bypasses lizardpack auto-detect
- `buildCommand`
- `startCommand`, `preDeployCommand` — `preDeployCommand` runs before `startCommand` at the start of every container (each replica, each restart), and only when `startCommand` is also set (otherwise it is skipped). If it fails, the container never starts. Make it safe to run many times and at the same time.
- `watchPatterns` — string array, comma-separated or JSON
- `containerPort` — TCP port the app listens on (a new `lizard up` service gets 3000 unless `--port` or an `EXPOSE` says otherwise). Set to `0` for [worker mode](#worker-mode).
- `name` — rename a service (lowercase a-z, digits, hyphens; 1–40 chars). Goes through `config:apply`; the legacy `PATCH /api/apps/:id` returns 410. Refs to the old name (`${{old.KEY}}`) stop resolving: update them.

Field names are flat and match the wire schema 1:1 (and `service show` output). No `build.*` / `deploy.*` / `source.*` grouping exists in the API, DB, or node-agent.

`service set` uses optimistic concurrency via `configRevision`. On 409, re-read with `lizard service show`, reconcile, retry; `--force` overrides.

### Tarball upload (no git remote, or quick local iteration)

```
lizard up --json
```

- Uploads cwd as a tarball (at most 150 MB compressed) and forces `sourceType=upload`. In a git repo it sends tracked files plus untracked files that `.gitignore` doesn't exclude; outside git it skips `node_modules`, `.git`, `dist`, `build`, `.next`, virtualenvs and caches, so a prebuilt `dist/` is not sent. There is no `.lizardignore`, and `.dockerignore` is not read.
- Streams build logs; ends with `{ event: "deployed", status: "running", url }`. A failed build ends with `{ event: "error", message }` and exit 1; no `deployed` event means the service isn't running yet (see the core guide).
- With no linked service, `up` deploys into the service named like `package.json` `name` (else the folder), and switches it to an upload even if it was git-backed. `--service <name>` deploys to that service, creating it when none has the name; a folder linked to an addon (after `lizard add postgres`) is treated as unlinked.
- Flags: `--project`, `--service`, `--region`, `--build-command`, `--start-command`, `--pre-deploy-command`, `--port`, `--detach`, `--ci`.
- If cwd isn't linked and no `--project` is given, it links the folder to the default project (see the core guide) and deploys there as a new service. `--project <name>` uses that project, or creates it if none matches. It never creates a project from the folder name on its own.
- `lizard up` always switches the service to `sourceType=upload`. Do not use it to update a git-backed service — use `lizard redeploy` or push to the remote.

## Worker mode

For services that don't expose an HTTP listener (background workers, reconcilers, queue consumers, cron-style polling loops), set `containerPort=0`. The platform then:

- Skips `PORT` env injection (the worker doesn't bind anywhere).
- Runs no readiness check, and each deploy stops the old copy before starting the new one (two copies never overlap).
- Skips `EXPOSE` in the synthesized Dockerfile.
- A generated `.onlizard.com` domain and route may still exist; they answer with an error.

Set it one of three ways:

```
lizard up --port 0                              # new upload-source worker
lizard port 0 [--service <svc>]                 # flip existing service to worker mode, then `lizard redeploy`
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

App secrets override project secrets. Platform vars come last and cannot be shadowed: `PORT` (absent in worker mode), `LIZARD_PROJECT_ID`, `LIZARD_SERVICE_NAME` (an internal `app-…` handle, not the dashboard name), `LIZARD_PUBLIC_DOMAIN` (absent until the service has a domain; a comma list once a custom domain is attached) and `LIZARD_PRIVATE_DOMAIN`. For service-to-service URLs use `${{<svc>.LIZARD_PRIVATE_DOMAIN}}`, not the service name. A `PORT` you set yourself doesn't override the injected one, but it becomes `containerPort` at the next deploy when the port wasn't set explicitly. Addon-issued env is every running Postgres and Redis addon's public `DATABASE_URL` / `REDIS_URL`, injected into every service at its next deploy or secret change; with two addons of a type, either may win.

### Secret scoping

Default to service-scope. `--global` puts the value into `process.env` of every service in the project — including ones that don't need it.

Rules:

- Check first: `lizard secrets list` (+ `--global`) before set/update — avoid creating a duplicate or shadowing an existing key (service scope wins over global; see [Precedence](#precedence-last-writer-wins)).
- Default — service-scope: `lizard secrets set KEY=v --service <svc>` per consumer. For addon DSNs, prefer a private reference when the consumer can reach it: `lizard secrets set DATABASE_URL='${{postgres.DATABASE_PRIVATE_URL}}' --service <svc>` (no separate `env` command — refs are interpolated wherever they appear). Refs are read again on every deploy, redeploy and secret change, not on `lizard restart`; there is no automatic credential rotation. A ref to another service sees only its stored values and platform vars, not the `DATABASE_URL` it got automatically.
- `secrets import` keeps quotes and `export ` prefixes as part of the value: strip them first.
- `--global` only for non-secrets and provably-public values: `LOG_LEVEL`, `NODE_ENV`, feature flags, frontend `SENTRY_DSN`. If unsure whether a value is a secret, treat it as one. A compromised service reads its own env; broader scope = more credentials exposed for no reason.

### Applying an env change

- Runtime vars/secrets apply without rebuilding the image. The application process restarts to read its new environment; do not promise uninterrupted requests.
- `VITE_*` / `NEXT_PUBLIC_*` (build-time baked) → setting one redeploys the running services that receive it; a plain restart won't pick them up. Only some builds bake them in: lizardpack or a reused repo Dockerfile on a GitHub service, or a Node-style build generated from `buildCommand`/`startCommand`. A `dockerfilePath` build, or a `lizard up` upload without those overrides, gets no Lizard variables at build time, and no build gets build args except `COMMIT_SHA`. For public values there, commit them in `.env.production`, set a build command, or write them into the Dockerfile.
- Verify a non-secret value or the application's behavior. Do not print the full environment: it can expose credentials.

## Managed addons

Provision with `lizard add <type>`. Each addon exposes a fixed env-var set; reference by name from a consumer service via `${{<addon-name>.KEY}}`. The first addon of a given type gets the bare type as its name (so use `postgres` in the reference for the first Managed Postgres instance); subsequent ones get `{type}-{adjective}-{noun}` like `postgres-autumn-bear`. There's no type-alias fallback — a ref must use the addon's actual name. Refs match the addon's current name, so renaming it breaks existing refs: update them after a rename. Every running Postgres and Redis addon's `DATABASE_URL` / `REDIS_URL` also reaches every service in the project at the lowest precedence; a value set on the consumer overrides it.

- `postgres` — two connection URLs: prefer `DATABASE_PRIVATE_URL` when available and reachable within the same project and region (no ingress/egress charges); use `DATABASE_URL` for public access, such as local clients or external CI (network charges may apply). Private URLs resolve only in the addon's region, and `lizard add` defaults to `us-east-1`. Also exposes `PGHOST`, `PGPORT` (the public endpoint), `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `POSTGRES_USER`, `POSTGRES_DB`, `POSTGRES_PASSWORD`.
- `redis` — `REDIS_URL`; services in the same project should use `REDIS_PRIVATE_URL`. No eviction policy and no append-only file are configured: if it runs out of memory, the instance restarts and recent writes can be lost. Keep data you cannot lose in Postgres.
- `s3` — `S3_ENDPOINT`, `S3_DEFAULT_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`. Auto-creates a private bucket named `default`; each S3 addon stores up to 16 GiB. Make a bucket public from the dashboard's S3 browser; objects in a public bucket are served without auth two ways: the gateway URL the dashboard shows, `https://s3-<region>.onlizard.com/<addonId>/<bucket>/<key>`, or the platform proxy `<dashboard-host>/api/s3/<addonId>/public/<bucket>/<key>` (the host `lizard open` launches; long-lived immutable cache headers). For AWS SDK use, set `forcePathStyle: true`. ACL flips aren't on the CLI yet, so point users at the dashboard. To push a local file into a bucket directly (no AWS SDK needed), use `lizard s3 upload <file> [--addon <name>] [--bucket <name>] [--key <key>] [--content-type <type>]` — auto-resolves the project's only S3 addon and bucket `default` if omitted; prints `{key, etag, size, url}` (`url` is `null` unless the bucket is public). `lizard s3 list|ls [--bucket <name>] [--prefix <p>]` lists objects in a bucket. `lizard s3 url <key> [--expires <seconds>]` prints a presigned link (default 1 hour, at most 7 days) that downloads a private object without credentials. The CLI has no ACL command: make a bucket public in the dashboard, or with an S3 `PutBucketAcl` (`public-read`) call using the addon's credentials.

## Composition patterns

Multi-step requests follow natural chains. Return one unified response, don't farm out steps:

- First deploy from git — pick action via the setup decision flow in the core guide → `lizard add -r owner/repo` → stream build → surface URL.
- First deploy from local code — Setup decision flow → `lizard up` → surface URL.
- Add a managed database to an existing service — `lizard add postgres` → bind the consumer's `DATABASE_URL` to the private reference as described above (the service restarts with it; no redeploy needed).
- Keep files across deploys — `lizard volume create data --service <svc> --mount-path /data` (one volume per service; the service restarts with it) → point the app's file paths there.
- Add object storage to a service — `lizard add s3` → reference `${{s3.S3_ENDPOINT}}`, `${{s3.S3_DEFAULT_BUCKET}}`, `${{s3.S3_ACCESS_KEY_ID}}`, `${{s3.S3_SECRET_ACCESS_KEY}}`, `${{s3.S3_REGION}}` from the consumer service. The `default` bucket is private; to serve files without auth, have the user make it public in the dashboard's S3 browser, then objects are served at `<dashboard-host>/api/s3/<addonId>/public/default/<key>`. See [Managed addons](#managed-addons).
- Wire a fresh git source on an existing service — `service set --set sourceType=github --set repoUrl=… --set branch=…` (rebuilds a running service by itself; otherwise `redeploy`).
- Fix a failed build — `logs --build --service <svc>` → diagnose → fix project (user's repo) OR adjust `buildCommand` / `startCommand` via `service set` → `redeploy --service <svc> --wait` → `logs` to verify.
- Fix a crash-looping service — `logs --restart latest --service <svc>` → fix the cause (secret, port, code) → `redeploy --service <svc> --wait`: a service whose first deploy failed gets its URL only from a successful deploy.
- Add a custom domain — `domain <host> --service <svc>` (the hostname is a positional, there is no `add` subcommand) → give the user `dnsRecords` → `domain verify <host> --service <svc>` once DNS propagates (it checks only the TXT; nothing verifies on its own). `domain list --service <svc>` shows pending domains. If the host is already attached to another of the user's services, the attach 409s with a reclaim hint — re-run with `--force` to move it here.

## Logs, metrics and lizard run

`lizard metrics --all` ignores the directory's linked service for this command.
It uses the linked project unless `--project <name>` selects another project.
Without `--all`, metrics defaults to the linked service, or the project overview
when no service is linked. Do not combine `--all` with `--service`.
The project overview includes `Egress` (outbound bytes per second) and `Volumes`
(used / total bytes). These columns use the latest sample from the past hour;
`Sampled` refers to CPU and memory. Missing measurements show `—`.
Watch mode refreshes CPU and memory every 3 seconds and I/O history every 30 seconds.
JSON output includes the history in each service's `series` and `timestamps` fields.

`lizard run --service <app>` injects stored values only: `${{…}}` refs arrive as literal text, and platform vars (`PORT`, `LIZARD_*`) are not set. `--service <addon>` injects the addon's real connection values, so use it to run a local command against a database. To check a service's wiring, use `lizard logs --build --service <svc>` (it warns about every reference that came back empty), `lizard secrets list --service <svc> --json` (names) and `lizard secrets list --ref --service <svc> --json` (the references that resolve; `available: false` for an addon that isn't running); shell access into services is off.

For exact flags, `lizard <cmd> --help --json`. Other commands not shown above: `lizard git` (GitHub integration), `lizard config` (project configuration), `lizard workspace` (workspace info) — discover each with `lizard <cmd> --help --json`.
