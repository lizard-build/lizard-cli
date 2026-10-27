# Sandboxes in depth

The details behind the Sandboxes section of the core guide. Read the part the task needs.

## Contents

- [Templates](#templates)
- [Running commands](#running-commands)
- [Files](#files)
- [Ports](#ports)
- [Lifetime](#lifetime)
- [Size and pricing](#size-and-pricing)
- [Interactive shell](#interactive-shell)
- [Coding agents](#coding-agents)
- [Desktop (computer use)](#desktop-computer-use)
- [Volumes](#volumes)
- [Snapshots and pause/resume](#snapshots-and-pauseresume)

## Templates

| `-t` | What is inside |
|---|---|
| `base` (default) | Python 3.11 on Alpine Linux, nothing else |
| `interpreter` | Python 3.11 with numpy, pandas, matplotlib, scipy, requests, httpx and IPython; Node 22 and `lizard` |
| `codex`, `claude`, `opencode`, `pi`, `prime` | One coding agent each (Codex, Claude Code, OpenCode, pi, Prime Agent) on Node 22, with git, python3, ripgrep, curl, jq and `lizard`: see [Coding agents](#coding-agents) |
| `desktop` | A graphical desktop with Chromium, plus Codex and `lizard`: see [Desktop](#desktop-computer-use) |

An unknown name fails and lists the region's `availableTemplates`. `--with-token` on `sandbox create` signs in the sandbox's own `lizard` with a new key limited to the sandbox's project, deleted with the sandbox (only useful on templates that ship `lizard`).

## Running commands

`lizard sandbox exec <id> -- <cmd> [args...]` runs the command in the sandbox, streams stdout and stderr, and exits with the command's exit code. Each argument stays one word: `exec <id> 'cd /workspace && npm test'` fails with `not found`, so put a shell line in `-- sh -c '…'`. Without a terminal it prints the raw output without the `$ <cmd>` header. Each call is a new process that starts in `/root`, so `cd` and exported variables don't carry over: chain steps in one call, e.g. `lizard sandbox exec <id> -- sh -c 'cd /workspace && npm test'`, and keep results in files.

A call gives up after 150 seconds (exit `4`, `EXEC_TIMEOUT`; the command may still be running) and keeps at most 512 KB of output. Run longer work in the background and poll a log:

```
lizard sandbox exec <id> -- sh -c 'cd /workspace && nohup npm run build > build.log 2>&1 &'
lizard sandbox exec <id> -- tail -n 50 /workspace/build.log
```

Ports 25, 465, 587 and 2525 are blocked for outbound traffic: sandboxes cannot send mail directly. Lizard's own hosts answer a sandbox only on ports 80 and 443, so the public URLs of managed Postgres and Redis (high ports on those hosts) time out from inside a sandbox; reach them from a deployed service or from the user's machine.

## Files

```
lizard sandbox files ls <id> [path]              # default /
lizard sandbox files cat <id> <path>
lizard sandbox files put <id> <local> <remote>
lizard sandbox files get <id> <remote> <local>
lizard sandbox files rm <id> <path>
```

`ssh` starts in `/workspace` and volumes mount there; `exec` starts in `/root`, so use absolute paths. `files put` and `files get` keep binary files intact. `files get` and `files cat` stop at 15 MiB (HTTP 413); `files put` takes about 110 MB.

## Ports

`lizard sandbox expose <id> <port> --json` publishes a port inside the sandbox on an HTTPS URL, `https://<id>-<port>.sandbox.<region>.onlizard.com/?lizard_token=…`; `lizard sandbox unexpose <id> <port>` removes it. One token opens every port of that sandbox, so treat the URL like a password. The server can listen on `127.0.0.1` or `0.0.0.0`.

- A browser opening the URL trades the token for a cookie and is redirected, so the link just works.
- `curl` gets an empty `302`, and `curl -L` without a cookie jar gets `401`. From a script send the header instead: `curl -H "X-Lizard-Access-Token: <accessToken>" https://<hostname>/` (both come in the `--json` output), or keep cookies: `curl -sL -c jar -b jar '<url>'`.
- A `POST` with `?lizard_token=` passes straight through, so webhooks work.
- Port `49983` is the platform's and can't be exposed.

## Lifetime

`lizard sandbox create` and `lizard sandbox restore` send a five-minute lifetime (`300000` milliseconds) by default. Pass `--timeout 0` to create a sandbox without a deadline (the VM itself still stops after 596 hours), or pass an integer up to `2147483647` milliseconds. This is a lifetime, not an idle timer: commands do not reset it. `lizard sandbox timeout <id> <ms>` sets a new lifetime of at least `1000` milliseconds. Pausing a sandbox freezes its remaining lifetime; resuming continues from it (see [private snapshots and pause/resume](#snapshots-and-pauseresume)). Copies from `sandbox fork` keep the source's lifetime unless `--timeout` sets another. Use volumes for persistent files.

## Size and pricing

`lizard sandbox create -s/--size small|medium|large` picks the machine; the default is `medium`. On the Pro trial the only size is `small` (also the default) and only US regions work: another size or region answers 403 `TRIAL_SANDBOX_SIZE` / `TRIAL_SANDBOX_REGION`, and `lizard billing start-now` lifts it. There are exactly three sizes:

| Size | vCPU | RAM | Disk | Price |
|---|---|---|---|---|
| `small` | 2 | 4 GiB | 5 GB | $0.0162/h |
| `medium` (default) | 4 | 8 GiB | 20 GB | $0.0324/h |
| `large` | 8 | 16 GiB | 50 GB | $0.0648/h |

Prices are per hour, billed per second while the sandbox runs, flat by size: measured CPU/RAM is not charged, and disk and egress are included. A paused sandbox costs nothing. Attached volumes bill separately. `--size` cannot be combined with `--snapshot`: a snapshot restores at the size it was captured at (see [private snapshots](#snapshots-and-pauseresume)).

Lizard Sandboxes run as Firecracker microVMs, each with its own kernel. If a sandbox cannot start, creation fails with an error.

An account runs at most 5 sandboxes at once on a trial and 100 after its first paid invoice (paused ones don't count), with limits on starts per minute, hour and day. Enterprise has no fixed limit on sandboxes running at once: each customer's agreement sets the limit per workspace, and running, paused and crashed sandboxes all count toward it. Over a limit the API answers 429 `SANDBOX_LIMIT_REACHED` or `SANDBOX_RATE_LIMITED` (with `retryAfterS`).

## Interactive shell

`lizard sandbox ssh <id>` (alias `shell`) opens an interactive shell in any running sandbox,
in `/workspace` as root. It uses your Lizard login, so there are no SSH keys to set up; a
scoped API key only reaches sandboxes in its scope. It needs a real terminal — from a script
or an agent, use `lizard sandbox exec <id> -- <cmd>` instead, which returns output and an
exit code.

## Coding agents

Run a coding agent in a sandbox made from its template (`-t codex`, `-t claude`, `-t opencode`, `-t pi`, `-t prime`) on the user's own credentials. Give the sandbox a real lifetime (`--timeout 3600000`): at five minutes it is deleted with the agent mid-task. Another template with Node installs the agent at the first prompt, which is slow; one without Node can't run agents.

- `lizard agents` — your account's credentials and which agents can run. Connect once (here or in the
  dashboard: Account settings › Agents); every sandbox and every agent that accepts it uses it.
- `lizard agents login chatgpt` — ChatGPT subscription via device code.
  `lizard agents add claude` (token from `claude setup-token`), `add anthropic|openai|openrouter|llmgateway|deepseek` for API keys.
- `lizard agents use <agent> --credential … --model … --effort …` — per-agent defaults.
- `lizard sandbox prompt <id> --agent codex|claude|pi|opencode|prime "task" --json` — one JSON event per
  line: tool calls, then a `response` event whose `text` is the answer, then `finished` or `failed`.
  `-c <conversation>` continues one; `--cwd` (default `/workspace`), `-m <model>`, `--effort
  minimal|low|medium|high|xhigh`. `--no-wait` returns at once, and the CLI has no command to read the
  answer later, so prefer waiting.
- `lizard sandbox conversations <id>`, `lizard sandbox interrupt <id> [-c <conversation>]`.

Codex and Claude Code use one credential at a time; pi, OpenCode and Prime use every connected one
they accept. A ChatGPT login reaches the sandbox only as a short-lived access token. API keys and the
Claude token go in as they are (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`), so any code in the
sandbox can read them. `lizard agents` needs a full sign-in: a key limited to projects gets 403
`ACCOUNT_SCOPE_REQUIRED`. A failed agent login is not always the user's credential: report the
error as it is.

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

`lizard-desktop screenshot` prints the PNG as base64 wrapped at 76 columns; the `grep` keeps only those lines (in a terminal it drops the `$ <cmd>` header `sandbox exec` prints). Use `--path` to save the PNG, then download that path with `lizard sandbox files get <id> <remote-path> screen.png`. `files put` and `files get` preserve binary files.

## Volumes

Use `lizard volume create <name> --size <gb> --project <project>` for persistent sandbox storage. Names are unique within a project; use lowercase letters, digits and dashes (up to 64 characters). Pass the name to `lizard sandbox create --volume <name>`. New volumes default to 5 GB and allow 1–50 GB. The CLI reads the server's current size limits before creating a volume; a server config override may change the maximum. Existing larger volumes keep their size. Storage charges cover used bytes, not the whole allocation.

Persistent volumes for sandboxes. A volume's name is its key within the project; every command takes a name or ID.

```
lizard volume create <name> [--size <gb>] [--region <code>]   # default 5 GB; a sandbox with --volume starts in its region
lizard volume list --json                                     # name, sizeGb, status, attachedTo
lizard volume resize <name> --size <gb>                       # grow in place
lizard volume rm <name> [-y]                                  # refused while attached; delete the sandbox first
lizard sandbox create --volume <name>                         # attach at create time
```

A volume attaches to one sandbox at a time (409 `Volume is already attached to another sandbox`); a paused sandbox keeps its volume. A workspace holds 200 GB of volumes by default (`volume_quota_exceeded`). For a deployed service's volume, see `lizard volume create <name> --service <svc>` in the core guide.

`volume resize` is online: an attached sandbox keeps running, and its `/workspace` shows the new size right away. A volume grown while detached gets the new size when a sandbox next mounts it. A volume grows but does not shrink: asking for less fails with `volume_shrink_unsupported`. Older volumes are the exception: they can shrink if at least 10% of the new size stays free (`volume_too_full_to_shrink` otherwise). The size limit (`volume_too_large`) and the workspace's volume quota apply as at create. `The volume is not ready` (HTTP 409) right after create means retry in a few seconds.

## Snapshots and pause/resume

- `lizard sandbox snapshot <sandbox-id> --name my-app` saves files and running memory. You and the members of its project can list, restore and delete it; only you change its scope. By default it restores into any of your projects and workspaces; `--scope workspace` keeps it to the sandbox's workspace and `--scope project` to its project, and `sandbox snapshot-scope <id> <user|workspace|project>` changes that later. A Firecracker snapshot is ready as soon as the capture ends; the command waits until ready; `--no-wait` returns the queued capture.
- `lizard sandbox restore <snapshot-id> [--project <project>] [--timeout <ms>]` starts a new sandbox from it (five-minute lifetime by default), in the snapshot's project unless `--project` names another. `--volume <volume>` mounts a volume at `/workspace` in the restored sandbox (Firecracker snapshots of a sandbox that had no volume attached; the volume must be in the snapshot's region). `sandbox create --snapshot <id> --project <project> [--volume <volume>]` also works. Restores stay in the snapshot's region. A snapshot restores at its source's size and bills flat at that size. `--size` with `--snapshot` is an error.
- `lizard sandbox snapshots --project <project>` lists a project's snapshots; `--mine` lists every snapshot you took. `sandbox snapshot-rm <id>` deletes the snapshot; sandboxes already started from it keep running.
- `lizard sandbox fork <sandbox-id> [-n <count>] [--timeout <ms>] --json` starts 1–100 live copies of a running sandbox: the platform pauses it for a moment, captures memory, processes and files once, and boots every copy from that capture; the source keeps its id and lifetime. Use it to fan out work from one prepared sandbox (tools installed, app loaded) without repeating the setup. Each copy is a sandbox start: it counts toward the running and start limits, runs at the source's size and bills like a new sandbox. The JSON is one entry per copy, `{ "sandbox": {…} }` or `{ "error": "…" }` (for example `Sandbox limit reached`); if any copy failed the command exits `1`, and the copies that did start keep running until you delete them. `--timeout` takes at least `1000`; leave it out to keep the source's lifetime. A sandbox with a volume attached can't be forked (409), and `fork` needs a running sandbox (409 for a paused one).
- `lizard sandbox pause <id>` snapshots and stops a Firecracker VM, stops billing, and freezes its remaining lifetime. `sandbox resume <id>` restores the same sandbox ID, files, processes, memory, published ports, and remaining lifetime. Resume is a cold restore. Both support `--no-wait`. `lizard sandbox pause <id> --fast` (API `{"fast": true}`, SDK `pause({ fast: true })` / `pause(fast=True)`) saves files only: it takes about a second whatever the sandbox's RAM, processes end, and resume boots the sandbox fresh with its files (`memoryRestored: false` in the resume JSON). Use it when nothing running needs to survive; use a plain pause to come back to running processes.
- Disconnect clients and terminals and stop workspace writes before capturing or pausing. To reuse one snapshot across sandboxes that each keep their own data, snapshot a sandbox with no volume attached and pass `--volume` on each restore; a snapshot taken with a volume attached cannot take a different one.
