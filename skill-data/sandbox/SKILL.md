---
name: lizard-sandbox
description: "Creates and manages Lizard sandboxes with the `lizard` CLI and Lizard SDK: a cloud sandbox (a Firecracker microVM) to run commands and code, copy files in and out, expose ports over HTTPS, open a shell, run Claude Code or Codex, drive a desktop and browser for computer use, keep files on volumes, and pause, snapshot or restore. Use for any sandbox task: an isolated sandbox, cloud machine or code interpreter, running untrusted or AI-generated code, or giving an agent its own computer."
argument-hint: "[optional natural-language request]"
allowed-tools: Bash(lizard:*), Bash(~/.lizard/bin/lizard:*), Bash(which:*), Bash(command:*), Bash(npm install:*)
---

# Lizard sandboxes

A sandbox is a Linux machine for running code and agents: a Firecracker microVM with its own kernel. It lives 5 minutes by default and is then deleted with its files. If `lizard` isn't on PATH, install it: `curl -fsSL https://lizard.build/install.sh | bash` on macOS and Linux (if `lizard` is still not found, call `~/.lizard/bin/lizard`), or `npm install -g @lizard-build/cli` on Windows. The install script ends by signing in: see [Sign-in](#sign-in).

If `$ARGUMENTS` is non-empty, treat it as the user's request and act on it. If empty, ask what they want to run.

## Sandbox or deploy?

- **Sandbox:** run code, tests, a build or an agent on demand, for minutes or hours, then delete it or snapshot it. The place for untrusted or AI-generated code.
- **Deploy** (`lizard up`): a service that keeps running and serves traffic at a stable URL, with managed databases next to it. For that, run `lizard skills get core --json`.

## Quickstart

```
lizard sandbox create --json                              # base template, medium size, 5-minute lifetime; the JSON has the id
lizard sandbox exec <id> -- python3 -c 'print(2 ** 10)'   # exits with the command's exit code
lizard sandbox files put <id> ./app.py /workspace/app.py
lizard sandbox exec <id> -- python3 /workspace/app.py
lizard sandbox expose <id> 8000 --json                    # an HTTPS URL for a port in the sandbox
lizard sandbox timeout <id> 3600000                       # keep it for an hour from now
lizard sandbox rm <id> -y                                 # delete it now
```

`lizard sandbox list --json` shows the project's sandboxes; `--all` shows every one you have.

## Templates

| `-t` | What is inside |
|---|---|
| `base` (default) | Python 3.11 on Alpine Linux, nothing else |
| `interpreter` | A Python code-interpreter environment |
| `codex` | Coding agents: see [Coding agents](#coding-agents) |
| `desktop` | A graphical desktop with Chromium: see [Desktop](#desktop-computer-use) |

The platform validates the name; `lizard sandbox create --help --json` lists the templates this CLI knows.

## Running commands

`lizard sandbox exec <id> -- <cmd> [args...]` runs the command through `sh -c` in the sandbox, streams stdout and stderr, and exits with the command's exit code. In JSON mode it prints the raw output without the `$ <cmd>` header. Each call is a new process, so `cd` and exported variables don't carry over: chain steps in one call, e.g. `lizard sandbox exec <id> -- sh -c 'cd /workspace && npm test'`, and keep results in files.

## Files

```
lizard sandbox files ls <id> [path]              # default /
lizard sandbox files cat <id> <path>
lizard sandbox files put <id> <local> <remote>
lizard sandbox files get <id> <remote> <local>
lizard sandbox files rm <id> <path>
```

`/workspace` is the working directory: `ssh` starts there and volumes mount there. `files put` and `files get` keep binary files intact.

## Ports

`lizard sandbox expose <id> <port>` publishes a port inside the sandbox on an HTTPS URL; `lizard sandbox unexpose <id> <port>` removes it. The URL carries the sandbox's access token, so treat it like a password. The platform keeps one port for itself and refuses to expose it.

## Lifetime

`lizard sandbox create` sends a five-minute lifetime (`300000` milliseconds) by default. Pass `--timeout 0` to create a sandbox without expiration, or pass an integer up to `2147483647` milliseconds. This is a lifetime, not an idle timer: commands do not reset it. `lizard sandbox timeout <id> <ms>` sets a new lifetime of at least `1000` milliseconds. Pausing a sandbox freezes its remaining lifetime; resuming continues from it (see [private snapshots and pause/resume](#snapshots-and-pauseresume)). The CLI has no sandbox fork command. Use volumes for persistent files.

## Size and pricing

`lizard sandbox create -s/--size small|medium|large` picks the machine; the default is `medium`. There are exactly three sizes:

| Size | vCPU | RAM | Disk | Price |
|---|---|---|---|---|
| `small` | 2 | 4 GiB | 5 GB | $0.0162/h |
| `medium` (default) | 4 | 8 GiB | 20 GB | $0.0324/h |
| `large` | 8 | 16 GiB | 50 GB | $0.0648/h |

Prices are per hour, billed per second while the sandbox runs, flat by size: measured CPU/RAM is not charged, disk is included, and egress is included up to 2 TB per account over a rolling 30 days (past that, the account's sandboxes lose outbound network until the total drops). A paused sandbox costs nothing. Attached volumes bill separately. `--size` cannot be combined with `--snapshot`: a snapshot restores at the size it was captured at (see [private snapshots](#snapshots-and-pauseresume)).

Sandboxes run as Firecracker microVMs, each with its own kernel. A sandbox that attaches an existing pod-backed volume, or restores an older pod snapshot, runs as a Kubernetes pod instead.

## Interactive shell

`lizard sandbox ssh <id>` (alias `shell`) opens an interactive shell in any running sandbox,
in `/workspace` as root. It uses your Lizard login, so there are no SSH keys to set up; a
scoped API key only reaches sandboxes in its scope. It needs a real terminal — from a script
or an agent, use `lizard sandbox exec <id> -- <cmd>` instead, which returns output and an
exit code.

## Coding agents

Run a coding agent inside a sandbox (use `-t codex`) on the user's own credentials:

- `lizard agents` — your account's credentials and which agents can run. Connect once (here or in the
  dashboard: Account settings › Agents); every sandbox and every agent that accepts it uses it.
- `lizard agents login chatgpt` — ChatGPT subscription via device code.
  `lizard agents add claude` (token from `claude setup-token`), `add anthropic|openai|openrouter|llmgateway|deepseek` for API keys.
- `lizard agents use <agent> --credential … --model … --effort …` — per-agent defaults.
- `lizard sandbox prompt <id> --agent codex|claude|pi|opencode|prime "task"` — streams tool calls and
  the answer; `-c <conversation>` continues one; `--no-wait` returns at once.
- `lizard sandbox conversations <id>`, `lizard sandbox interrupt <id> [-c <conversation>]`.

Codex and Claude Code use one credential at a time; pi, OpenCode and Prime use every connected one
they accept. Sandboxes never receive a subscription's refresh token, only a short-lived access token.

Use `sandbox exec` to read a log file written by your process.

## Desktop (computer use)

The `desktop` template is a sandbox with a graphical desktop (Openbox + Chromium) streamed to a browser over WebRTC (H.264), falling back to noVNC where WebRTC cannot connect. The viewer's side panel has fullscreen with keyboard lock, send-keys, type-clipboard and a switch to VNC.

```
lizard sandbox create -t desktop                          # only this template has a desktop
lizard sandbox desktop <id> --open                        # start it (idempotent) and open it in the browser
lizard sandbox desktop <id> --resolution 1920x1080        # 640-3840 x 480-2160
lizard sandbox desktop <id> --view-only                   # watch-only link
lizard sandbox desktop <id> --status                      # URLs/state without starting
lizard sandbox desktop <id> --stop                        # stop and unpublish
lizard sandbox vnc <id>                                   # native VNC app: tunnels localhost:5900 to the desktop
lizard sandbox vnc <id> --open                            # macOS: opens Screen Sharing; --view-only, --port N
```

The printed URLs embed secrets (the desktop's token and its password): the main URL grants control of the sandbox, so treat it like a password and don't paste it into logs, issues or chat; share `--view-only` for watching. On any other template the command fails with `DESKTOP_NOT_SUPPORTED`.

Agents drive the desktop from inside the sandbox once it is started (`DISPLAY=:1` is preset in the image):

```
lizard sandbox exec <id> -- xdotool mousemove 400 300 click 1
lizard sandbox exec <id> -- xdotool type 'hello'
lizard sandbox exec <id> -- lizard-desktop screenshot | grep -E '^[A-Za-z0-9+/=]+$' | base64 -d > screen.png
lizard sandbox exec <id> -- lizard-desktop screenshot --path   # writes the PNG to a file in the sandbox, prints its path
```

`lizard-desktop screenshot` prints the PNG as base64 wrapped at 76 columns; the `grep` keeps only those lines (it drops the `$ <cmd>` header `sandbox exec` prints). Use `--path` to save the PNG, then download that path with `lizard sandbox files get <id> <remote-path> screen.png`. `files put` and `files get` preserve binary files.

## Volumes

Use `lizard volume create <name> --size <gb> --project <project>` for persistent sandbox storage. Names are unique within a project; use lowercase letters, digits and dashes (up to 64 characters). Pass the name to `lizard sandbox create --volume <name>`. New volumes default to 5 GB and allow 1–50 GB. The CLI reads the server's current size limits before creating a volume; a server config override may change the maximum. Existing larger volumes keep their size. Storage charges cover used bytes, not the whole allocation.

Persistent volumes for sandboxes. A volume's name is its key within the project; every command takes a name or ID.

```
lizard volume create <name> [--size <gb>] [--region <code>]   # default 5 GB; region must match the sandbox's
lizard volume list --json                                     # name, sizeGb, status, attachedTo
lizard volume resize <name> --size <gb>                       # grow in place
lizard volume rm <name> [-y]                                  # refused while attached; delete the sandbox first
lizard sandbox create --volume <name>                         # attach at create time
```

`volume resize` is online: an attached sandbox keeps running, and its `/workspace` shows the new size right away. A volume grown while detached gets the new size when a sandbox next mounts it. Firecracker volumes (the default) only grow; asking for less fails with `volume_shrink_unsupported`. A Kubernetes volume can also shrink if at least 10% of the new size stays free (`volume_too_full_to_shrink` otherwise). The size limit (`volume_too_large`) and the workspace's volume quota apply as at create. `The volume is not ready` (HTTP 409) right after create means retry in a few seconds.

## Snapshots and pause/resume

- `lizard sandbox snapshot <sandbox-id> --name my-app` saves files and running memory privately. The snapshot is yours: by default it restores into any of your projects and workspaces; `--scope workspace` keeps it to the sandbox's workspace and `--scope project` to its project, and `sandbox snapshot-scope <id> <user|workspace|project>` changes that later. A Firecracker snapshot is ready as soon as the capture ends. A snapshot of a pod sandbox keeps **five** independent copies warm; `--warm 1..10` changes that count. It waits until ready; `--no-wait` returns the queued capture.
- `lizard sandbox restore <snapshot-id> [--project <project>]` starts a new sandbox from a warm copy, in the snapshot's project unless `--project` names another. `--volume <volume>` mounts a volume at `/workspace` in the restored sandbox (Firecracker snapshots of a sandbox that had no volume attached; the volume must be in the snapshot's region). `sandbox create --snapshot <id> --project <project> [--volume <volume>]` also works. Restores stay in the snapshot's region. A Firecracker snapshot restores at its source's size and bills flat at that size; a pod snapshot runs on the machine it was captured on and bills by measured usage. `--size` with `--snapshot` is an error.
- `lizard sandbox snapshots --project <project>` lists a project's snapshots; `--mine` lists every snapshot you took. `sandbox snapshot-warm <id> <count>` changes capacity. `sandbox snapshot-rm <id>` deletes the snapshot and free copies, preserving already running sandboxes.
- `lizard sandbox pause <id>` snapshots and stops a Firecracker VM (a pod sandbox is checkpointed with CRIU), stops billing, and freezes its remaining lifetime. `sandbox resume <id>` restores the same sandbox ID, files, processes, memory, published ports, and remaining lifetime. Paused sandboxes keep no warm copies; resume includes a cold restore. Both support `--no-wait`.
- Disconnect clients and terminals and stop workspace writes before capturing or pausing. On a pod sandbox, active TCP connections and unsupported CRIU process state cause a clear failure. To reuse one snapshot across sandboxes that each keep their own data, snapshot a sandbox with no volume attached and pass `--volume` on each restore; a snapshot taken with a volume attached cannot take a different one.

## From code: Lizard SDK

For an app or script that creates sandboxes itself, use Lizard SDK instead of calling the CLI:

| SDK | Install | Requires |
|---|---|---|
| TypeScript | `npm install @lizard-build/sdk` | Node.js 18+ |
| Python | `pip install lizard-sdk` | Python 3.10+ |

The SDK reads `LIZARD_API_KEY`. Create one with `lizard keys create <name> --project <project> --json`: a key limited to one project is safest when the code runs somewhere else.

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

Guides: [TypeScript](https://github.com/lizard-build/lizard-sdk/blob/main/packages/js/README.md), [Python](https://github.com/lizard-build/lizard-sdk/blob/main/packages/python/README.md), [sandbox reference](https://github.com/lizard-build/lizard-sdk/blob/main/docs/sandboxes.md).

<!-- include: _shared/basics.md -->
