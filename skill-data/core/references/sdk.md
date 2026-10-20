# Building with Lizard (Lizard SDK)

Use Lizard SDK when the user's own code creates and drives sandboxes or manages Lizard resources: an agent framework, a code-execution feature, a backend that gives each of its users a machine. For one-off work from a terminal, use the CLI instead.

## Contents

- [Install and configure](#install-and-configure)
- [Quickstart](#quickstart)
- [Commands and output](#commands-and-output)
- [Files](#files)
- [Stateful code (CodeSandbox)](#stateful-code-codesandbox)
- [Ports](#ports)
- [Keep files (volumes)](#keep-files-volumes)
- [Lifecycle, pause, snapshots and fork](#lifecycle-pause-snapshots-and-fork)
- [Desktop (computer use)](#desktop-computer-use)
- [Sandboxes for your own users](#sandboxes-for-your-own-users)
- [Platform APIs](#platform-apis)
- [Lizard Git from code](#lizard-git-from-code)
- [Billing from code](#billing-from-code)
- [Errors](#errors)

## Install and configure

| SDK | Install | Requires |
|---|---|---|
| TypeScript | `npm install @lizard-build/sdk` | Node.js 18.16+ |
| Python | `pip install lizard-sdk` | Python 3.10+ |

This guide matches SDK 0.1.59 or later.

The SDK reads `LIZARD_API_KEY` and, optionally, `LIZARD_API_URL` (default `https://lizard.build`); `apiKey` / `api_key` and `apiUrl` / `api_url` override them. It does not load `.env` files. Create a key with `lizard keys create <name> --project <project> --json`: a key limited to one project is safest when the code runs somewhere else. The key is shown once; pass it to the program as `LIZARD_API_KEY`. The `lizard` CLI's own sign-in is not read by the SDK. Static methods (`Sandbox.connect`, `Sandbox.list`, `Sandbox.restore`, `Sandbox.deleteSnapshot`, `CodeSandbox.create`) read `LIZARD_API_KEY` too, not the key given to `new Lizard`: on a server holding several keys pass `apiKey` / `api_key` to them, or use `lizard.connect(id)`.

Sandboxes and volumes need a project: `new Lizard({ project })` / `Lizard(project=...)` takes its ID, slug or unique name; use the exact ID when names are ambiguous. Platform APIs work without one.

Options for `create()` (TypeScript / Python):

| Option | Purpose |
|---|---|
| `size` | `small` (2 vCPU / 4 GB, $0.0162/h), `medium` (4 vCPU / 8 GB, $0.0324/h, default), `large` (8 vCPU / 16 GB, $0.0648/h) |
| `timeoutMs` / `timeout_ms` | Lifetime; default 300,000 ms (5 minutes); `0` means no deadline (the VM still stops after 596 hours) |
| `envs` | Environment variables for every command in the sandbox (up to 256) |
| `metadata` | Your own string labels, returned by `getInfo()` / `get_info()` (up to 64) |
| `region` | Region ID; omit to use the platform default |
| `volumeName` / `volume_name`, `volumeId` / `volume_id` | Attach a persistent volume at `/workspace` |
| `snapshotId` / `snapshot_id` | Start from a saved snapshot |
| `lizardToken` / `lizard_token` | One of your own keys: the sandbox's `lizard` gets a new key limited to its project, deleted with it. Someone else's key is skipped without an error |

Templates: `base` (default), `interpreter` (Python with data libraries, plus Node 22), `codex`, `claude`, `opencode`, `pi`, `prime` (one coding agent each), `desktop`. The SDK and CLI give a sandbox 5 minutes by default; the raw API and the dashboard give none. Commands do not reset the deadline. Pricing is flat by size, billed per second while the sandbox runs; a sandbox restored from a snapshot runs at the source's size and is billed at that size; volumes bill separately.

An account runs at most 5 sandboxes at once on a trial and 100 after its first paid invoice, with limits on starts per minute, hour and day: over a limit, a `LizardError` with status 429 and `code` `SANDBOX_LIMIT_REACHED` or `SANDBOX_RATE_LIMITED`. More than 32 commands at once in one sandbox gives `EXEC_LIMIT_REACHED`.

## Quickstart

```ts
import { Lizard } from '@lizard-build/sdk'

const lizard = new Lizard({ project: 'my-project' })
const sandbox = await lizard.create('base', { timeoutMs: 300_000 })
try {
  await sandbox.fs.write('/tmp/hello.txt', 'Hello from Lizard!')
  const result = await sandbox.process.exec('cat /tmp/hello.txt')
  if (result.exitCode !== 0) throw new Error(result.stderr)
  console.log(result.stdout)
} finally {
  await sandbox.kill()
}
```

```python
from lizard import Lizard

lizard = Lizard(project="my-project")
with lizard.create("base", timeout_ms=300_000) as sandbox:
    sandbox.fs.write("/tmp/hello.txt", "Hello from Lizard!")
    result = sandbox.process.exec_("cat /tmp/hello.txt")
    if result.exit_code != 0:
        raise RuntimeError(result.stderr)
    print(result.stdout)
```

Always kill the sandbox when done: `try/finally` in TypeScript, the `with` block in Python.

## Commands and output

`process.exec(cmd)` / `process.exec_(cmd)` returns stdout, stderr and the exit code. A nonzero exit code is a result to check; request failures throw or raise.

- `onStdout` / `onStderr` (`on_stdout` / `on_stderr`) stream output while the call still waits for the end.
- `timeoutMs` / `timeout_ms` bounds one command: 1–600 seconds, **60 seconds by default**. Past it the SDK gives up with a `DOMException` named `TimeoutError` (TypeScript) or `httpx.ReadTimeout` (Python), not a `LizardError`. Pass it for anything slower, such as `pip install`; run longer jobs with `nohup … &` and poll a log.
- Output keeps 512 KiB per stream, then `truncated` is set.
- `envs`, `workdir` and `user` (e.g. `user: 'user'`, the template's unprivileged account) apply to that command only.
- `onPid` / `on_pid` gives the pid before any output; `process.list()` lists commands and `process.kill(pid, 'SIGKILL')` signals the whole process tree.
- An argv array runs the binary without a shell, so text from a model or a user cannot run commands.

## Files

`fs.write`, `fs.read`, `fs.readBytes` / `fs.read_bytes`, `fs.list`, `fs.stat`, `fs.makeDir` / `fs.make_dir`, `fs.move`, `fs.remove`. Use absolute paths. Writes take text or bytes; bytes are stored exactly, so read binary files back with `readBytes()` / `read_bytes()`. A missing path raises `NotFoundError`. `list()` and `stat()` entries carry `type`, `size`, `mode`, `permissions`, `owner`, `group` and `modTime` (`mod_time` in Python). Reads stop at 15 MB (HTTP 413). File watching is not available yet.

## Stateful code (CodeSandbox)

`CodeSandbox` boots the `interpreter` template and runs Python in a persistent Jupyter kernel, so variables, imports and functions survive between calls. Plain `process.exec` starts a new process each time.

```ts
import { CodeSandbox } from '@lizard-build/sdk'

const sandbox = await CodeSandbox.create({ projectId })
try {
  await sandbox.runCode('import pandas as pd\ndf = pd.DataFrame({"x": [1, 2, 3]})')
  const run = await sandbox.runCode('int(df.x.sum())')
  const out = run.results[0]
  if (out?.type === 'result') console.log(out.data)   // "6"
} finally {
  await sandbox.kill()
}
```

```python
from lizard import CodeSandbox

with CodeSandbox.create(project_id=project_id) as sandbox:
    sandbox.run_code('import pandas as pd\ndf = pd.DataFrame({"x": [1, 2, 3]})')
    print(sandbox.run_code("int(df.x.sum())").results[0].data)   # "6"
```

An `Execution` has `stdout`, `stderr`, `results` (the last expression as text, charts and images as base64 PNG, HTML), `error` (`name`, `message`, `traceback`) and `executionCount`. A code error is a result, not an exception. `createContext()` / `create_context()` starts a separate kernel with its own state; `restartContext` clears one. `timeoutMs` (default 60 s) bounds one call: the kernel is interrupted, keeps its state, and `error.name` is `TimeoutError`. `bash` and `javascript` run as fresh processes with no state; `javascript` uses the template's Node 22. With numpy 2, a bare `df.x.sum()` displays as `np.int64(6)`: convert to `int` for plain output.

## Ports

Start the server on `0.0.0.0` inside the sandbox, then publish the port:

```ts
const { hostname, url, accessToken } = await sandbox.exposePort(3000)
const res = await fetch(`https://${hostname}/api`, { headers: { 'X-Lizard-Access-Token': accessToken } })
await sandbox.unexpose(3000)
```

```python
exposed = sandbox.expose_port(3000)
res = httpx.get(f"https://{exposed.hostname}/api", headers={"X-Lizard-Access-Token": exposed.access_token})
sandbox.unexpose(3000)
```

The port is private: every request needs the token in the `X-Lizard-Access-Token` header, or once as `?lizard_token=<token>` in a browser, which then keeps a cookie. `url` already carries the token, so treat it like a password. `getHost(port)` / `get_host(port)` returns only the hostname, without a scheme.

## Keep files (volumes)

Only files on an attached volume outlive the sandbox; volumes mount at `/workspace`. A volume attaches to one sandbox at a time, and the sandbox runs in the volume's region, so omit `region` when attaching one.

```ts
await lizard.volumes.getOrCreate('agent-files', { sizeGb: 10 })
const sandbox = await lizard.create('base', { volumeName: 'agent-files' })
```

```python
lizard.volumes.get_or_create("agent-files", size_gb=10)
sandbox = lizard.create("base", volume_name="agent-files")
```

Names are unique within a project: `getOrCreate` returns the existing volume, `create` raises `ConflictError`. New volumes are 1–50 GB (default 5). `volumes.list()`, `volumes.get(nameOrId)` and `volumes.delete(nameOrId)` (deletes the files too). Grow one with `lizard.volumes.resize('agent-files', 20)` / `lizard.volumes.resize("agent-files", 20)`; volumes only grow.

## Lifecycle, pause, snapshots and fork

| Task | TypeScript | Python |
|---|---|---|
| Reconnect by ID | `Sandbox.connect(id)` | `Sandbox.connect(id)` |
| Status | `sandbox.getInfo()` | `sandbox.get_info()` |
| New lifetime from now (1000–2147483647 ms) | `sandbox.setTimeout(ms)` | `sandbox.set_timeout(ms)` |
| List a project's sandboxes | `Sandbox.list({ projectId })` | `Sandbox.list(project_id=...)` |
| Kill | `sandbox.kill()` | `sandbox.kill()` |
| Pause and resume (memory and processes kept, billing stops) | `pause()`, `resume()`, `waitForStatus(s)` | `pause()`, `resume()`, `wait_for_status(s)` |
| Snapshot (about 2 s, the source keeps running) | `snapshot(name)` | `snapshot(name)` |
| Start a sandbox from a snapshot (about 0.4 s) | `Sandbox.restore(id)` | `Sandbox.restore(id)` |
| Live copies of a running sandbox (each counts toward the running limit) | `fork({ count })` | `fork(count=...)` |

A snapshot belongs to the user who took it and restores into any project they can use, unless its scope is `workspace` or `project` (`snapshot(name, { scope })`, `Sandbox.setSnapshotScope(id, scope)`). To start many sandboxes that each keep their own files from one snapshot, take it without a volume and pass `volumeId` to each `restore`. A sandbox with a volume cannot be forked. `fork()` returns one entry per copy, with `sandbox` or `error` (for example the account's sandbox limit). Delete snapshots with `Sandbox.deleteSnapshot(id)`; sandboxes already restored keep running.

## Desktop (computer use)

The `desktop` template has a graphical desktop with Chromium on `DISPLAY=:1`. `sandbox.desktop.start({ width, height })` starts it and returns `url` (watch and control) and `viewOnlyUrl` (watch only). Both are credentials: never log them, and share `viewOnlyUrl` when someone only needs to look. Then drive it with `screenshot()` (PNG bytes), `click(x, y)`, `moveMouse`, `drag`, `type(text)`, `press('ctrl+l')`, `scroll(direction)` and `openUrl(url)`. Input never goes through a shell. On other templates these calls fail with `DESKTOP_NOT_SUPPORTED`.

## Sandboxes for your own users

Each sandbox is its own microVM, so running every customer's code in a sandbox of its own already keeps customers apart: one project, one key limited to it, a sandbox per customer or per task tagged with `metadata` (`{ customerId }`), killed when done. That is the default.

Add a workspace and a key per customer only when customers get Lizard access of their own (their code calls Lizard, or you hand them a key). Creating workspaces needs an unscoped key; a scoped key gets 403. Run this on your trusted server:

```ts
const lizard = new Lizard({})
const workspace = await lizard.workspaces.create({ name: 'user-123' })
const project = await lizard.projects.create({ workspaceId: workspace.id, name: 'default' })
const key = await lizard.apiKeys.create({ name: 'user-123', workspaces: [workspace.id] })
// Store key.key and project.id now: the API returns the key only once.
const forUser = new Lizard({ apiKey: key.key, project: project.id })
```

```python
lizard = Lizard()
workspace = lizard.workspaces.create(name="user-123")
project = lizard.projects.create(workspace_id=workspace.id, name="default")
key = lizard.api_keys.create(name="user-123", workspaces=[workspace.id])
for_user = Lizard(api_key=key.key, project=project.id)
```

Keep `project.id`: every user's project is named `default`, so the name is ambiguous for your own key. Every user workspace bills to your account and counts toward your sandbox limits. A key without scopes reaches everything the account can; `workspaces` or `projects` limit it, and a scoped key cannot create a broader one. Scoped keys cannot see account billing (HTTP 403 `ACCOUNT_SCOPE_REQUIRED`). 

`workspaces.delete()` needs an empty workspace unless you pass `force`, and `force` removes apps, addons and projects but leaves sandboxes running and volumes and snapshots in place: kill the workspace's sandboxes and delete its volumes and snapshots first.

## Platform APIs

The same client manages the rest of Lizard: `projects`, `services` (deploy, inspect, scale, run commands), `addons` (managed databases), `secrets`, `domains`, `storage` (S3 objects), `github`, `metrics`, `workspaces`, `apiKeys` / `api_keys`, `regions`, `billing` and `volumes`. `whoami()` returns the identity behind the key. `platform` is the raw HTTP client for endpoints without a method. A config change that saved but failed to deploy raises `ConfigApplyError`: read its `result` before retrying.

## Lizard Git from code

`lizard.git` reaches Lizard Git (lizard.build/git) with the same key, which must have no scopes. Repositories are `"owner/name"`. Groups: `repos` (create, refs, tree, `file`, `raw`, `commits`, `commitFiles` / `commit_files` with `expect` and an idempotency key, `land`, `archive`, `cloneUrl`), `issues`, `pulls` (`create`, `ready`, `review`, `approve`, `lineComment`, `checks`, `merge`), `actions` (`runs`, `run`, `wait`, `fullLog`, `followLog`, `artifacts`, `downloadArtifact`, `dispatch`, `rerun`, `cancel`, `approve`; `actions.secrets`), `collaborators`, `webhooks`, `branchRules` / `branch_rules`, `labels`, `releases` (with `uploadAsset`), `statuses`, `notifications`, `tokens`. `me()` is the Lizard Git login. Set `LIZARD_GIT_URL` (or `gitUrl` / `git_url`) for another server.

```ts
await lizard.git.repos.commitFiles('me/app', { branch: 'main', message: 'CI', files: [{ path: '.lizard/workflows/ci.yml', content: yaml }] })
const run = await lizard.git.actions.wait('me/app', (await lizard.git.actions.runs('me/app')).runs[0].number)
```

## Billing from code

`billing.subscription()` returns the plan, trial and this month's usage; `billing.startCheckout()` / `start_checkout()` returns a Stripe Checkout URL for the trial or Pro, which the user finishes in a browser. `startProNow`, `cancel` and `resume` change what the account pays: call them only when the account owner asks.

## Errors

| Error | Meaning |
|---|---|
| `PaymentRequiredError` | HTTP 402: the account must start Pro, start it now, or pay an invoice. Show `message` as is and open `url`; retry after the user pays |
| `AuthenticationError` | HTTP 401 or 403: bad key, no access, or a refusal such as a volume quota, a snapshot's scope or `ACCOUNT_SCOPE_REQUIRED`: check `code` |
| `NotFoundError` | HTTP 404 |
| `ConflictError` | HTTP 409, such as a volume name in use |
| `TimeoutError` | HTTP 408 or 504 |
| `LizardError` | Other API failures, including unsupported operations |

Each error has the HTTP `status` (`status_code` in Python) and, when the API sends one, a `code`. `kill()` returns `false` for a sandbox that is already gone. Check command exit codes and code errors separately from API errors.

Full reference: [sandboxes](https://github.com/lizard-build/lizard-sdk/blob/main/docs/sandboxes.md), [platform](https://github.com/lizard-build/lizard-sdk/blob/main/docs/platform.md), [TypeScript](https://github.com/lizard-build/lizard-sdk/blob/main/packages/js/README.md), [Python](https://github.com/lizard-build/lizard-sdk/blob/main/packages/python/README.md).
