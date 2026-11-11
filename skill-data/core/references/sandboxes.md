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
- [Schedules (wake, run, sleep)](#schedules-wake-run-sleep)
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

A sandbox starts in `us-east-1` unless `--region` names another; with `--volume` or `--snapshot` it starts in their region. An unknown name fails and lists the region's `availableTemplates`. `--with-token` on `sandbox create` signs in the sandbox's own `lizard` with a new key limited to the sandbox's project, deleted with the sandbox (only useful on templates that ship `lizard`).

`--no-internet` on `sandbox create` starts a sandbox with no internet at all (no outbound TCP, UDP, DNS or ping) for its whole life, its resumes and forks included, and none of its ports can be made public (`sandbox expose` and the desktop are refused); commands and files still work. It is set at create only and cannot be changed later. Not available with a container volume or snapshot. Use it to run untrusted code that must not reach the network.

`--allow-host <host>` (repeatable, implies `--no-internet`) keeps a few destinations reachable: a host name such as `pypi.org`, or `*.pythonhosted.org` for its subdomains, on ports 80 and 443; or an IPv4 address or range such as `140.82.112.0/20` on every port. Up to 50; private ranges, IPv6 and ports are refused. With a host name in the list, DNS (8.8.8.8) is open too so names resolve, which means code can still send data out inside DNS lookups; a list of addresses only keeps DNS closed.

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

`ssh` starts in `/workspace` and volumes mount there; `exec` starts in `/root`, so use absolute paths. `files put` and `files get` keep binary files intact. `files get` and `files cat` stop at 15 MiB (HTTP 413); `files put` takes files of any size: over 64 MB it sends 32 MB pieces and joins them in the sandbox, which needs free disk for the file plus one piece.

## Ports

`lizard sandbox expose <id> <port> --json` publishes a port inside the sandbox on an HTTPS URL, `https://<id>-<port>.sandbox.<region>.onlizard.com/?lizard_token=…`; `lizard sandbox unexpose <id> <port>` removes it. One token opens every port of that sandbox, so treat the URL like a password. The server can listen on `127.0.0.1` or `0.0.0.0`.

- A browser opening the URL trades the token for a cookie and is redirected, so the link just works.
- `curl` gets an empty `302`, and `curl -L` without a cookie jar gets `401`. From a script send the header instead: `curl -H "X-Lizard-Access-Token: <accessToken>" https://<hostname>/` (both come in the `--json` output), or keep cookies: `curl -sL -c jar -b jar '<url>'`.
- A `POST` with `?lizard_token=` passes straight through, so webhooks work.
- Port `49983` is the platform's and can't be exposed.

## Lifetime

`lizard sandbox create` and `lizard sandbox restore` send a five-minute lifetime (`300000` milliseconds) by default. Pass `--timeout 0` to create a sandbox without a deadline (the VM itself still stops after 596 hours), or pass an integer up to `2147483647` milliseconds. This is a lifetime, not an idle timer: commands do not reset it. `lizard sandbox timeout <id> <ms>` sets a new lifetime of at least `1000` milliseconds. Pausing a sandbox freezes its remaining lifetime; resuming continues from it (see [private snapshots and pause/resume](#snapshots-and-pauseresume)). Copies from `sandbox fork` keep the source's lifetime unless `--timeout` sets another. Use volumes for persistent files. On the Pro trial a sandbox lives 1 hour at most, then it is deleted: no lifetime (or `0`) gets 1 hour, a longer one answers 403 `TRIAL_SANDBOX_LIFETIME` (`maxTimeoutMs: 3600000`), and `sandbox timeout` cannot move it past 1 hour from its creation (same 403 with `latestExpiresAt`); longer lifetimes unlock after the first payment.

## Size and pricing

`lizard sandbox create -s/--size nano|mini|small|medium|large` picks the machine; the default is `medium`. The Pro trial runs 1 Small, 2 Mini and 2 Nano at a time, in US regions only (no size = small); Medium and Large unlock after the first payment. Medium or Large answers 403 `TRIAL_SANDBOX_SIZE` (`allowedSizes: ["small", "mini", "nano"]`), another region 403 `TRIAL_SANDBOX_REGION`, and a second Small or a third Mini or Nano 403 `TRIAL_SIZE_RUNNING` (`size`, `sizeLimit`, `sizeLimits: {"small": 1, "mini": 2, "nano": 2}`): pause or delete one. Trial sandboxes are deleted 1 hour after they start at the latest (a longer `--timeout` answers 403 `TRIAL_SANDBOX_LIFETIME`, see [Lifetime](#lifetime)). `lizard billing start-now` lifts these limits. There are exactly five sizes:

| Size | vCPU | RAM | Disk | Price |
|---|---|---|---|---|
| `nano` | 0.5 | 1 GiB | 5 GB | $0.00405/h |
| `mini` | 1 | 2 GiB | 5 GB | $0.0081/h |
| `small` | 2 | 4 GiB | 20 GB | $0.0162/h |
| `medium` (default) | 4 | 8 GiB | 40 GB | $0.0324/h |
| `large` | 8 | 16 GiB | 80 GB | $0.0648/h |

Mini has no warm pool, so it starts only from templates with a disk-only build: `base`, `claude`, `codex` and `interpreter`. Any other template answers 400 `SANDBOX_SIZE_NOT_ALLOWED`; use `small` or larger for it.

Nano is half a vCPU: the sandbox sees 1 CPU (`nproc` says 1) but gets at most half a core of time, so CPU-bound work takes about twice as long as on Mini (the rest shows as steal time). It suits an idle shell or a coding agent waiting on a model. Nano starts only from `base`, `claude` and `codex`; any other template answers 400 `SANDBOX_SIZE_NOT_ALLOWED` with `templates`.

Disk is the sandbox's root file system (`/`): its home directory, `/workspace` and everything it installs share it (a volume, if attached, mounts over `/workspace`). `df -h` prints GiB, so it shows about 4.7G / 4.7G / 18.8G / 37.6G / 75.2G for `nano` / `mini` / `small` / `medium` / `large`. A sandbox restored from a snapshot keeps at least its snapshot's disk.

Prices are per hour, billed per second while the sandbox runs, flat by size: measured CPU/RAM is not charged, and disk and egress are included. A paused sandbox costs nothing. Attached volumes bill separately. `--size` cannot be combined with `--snapshot`: a snapshot restores at the size it was captured at (see [private snapshots](#snapshots-and-pauseresume)).

Lizard Sandboxes run as Firecracker microVMs, each with its own kernel. If a sandbox cannot start, creation fails with an error.

An account's limit counts vCPU of running sandboxes (Nano 1, Mini 1, Small 2, Medium 4, Large 8; paused ones don't count), across all of the owner's workspaces: 1 Small, 2 Mini and 2 Nano at a time on the trial (counted by size, not vCPU), 40 vCPU on Pro, 220 on Pro 5x and 1,200 on Pro 20x. Starts are limited only on the trial (6 a minute, 30 an hour, 100 a day); Pro, Pro 5x and Pro 20x have unlimited starts. Enterprise has no fixed limit on sandboxes running at once: each customer's agreement sets the limit per workspace, and running, paused and crashed sandboxes all count toward it. Over a limit the API answers 429 `SANDBOX_LIMIT_REACHED` (with `unit: "vcpu"`, `limit`, `running` and `needed`, all in vCPU) or `SANDBOX_RATE_LIMITED` (with `retryAfterS`).

## Interactive shell

`lizard sandbox ssh <id>` (alias `shell`) opens an interactive shell in any running sandbox,
in `/workspace` as root. It uses your Lizard login, so there are no SSH keys to set up; a
scoped API key only reaches sandboxes in its scope. It needs a real terminal — from a script
or an agent, use `lizard sandbox exec <id> -- <cmd>` instead, which returns output and an
exit code.

## Coding agents

Run a coding agent in a sandbox made from its template (`-t codex`, `-t claude`, `-t opencode`, `-t pi`, `-t prime`) on the user's own credentials. Give the sandbox a real lifetime (`--timeout 3600000`): at five minutes it is deleted with the agent mid-task. On the Pro trial 1 hour is the most a sandbox lives. Another template with Node installs the agent at the first prompt, which is slow; one without Node can't run agents.

- `lizard agents` — your credentials in the linked project (or `-p <project>`) and which agents can run.
  Connect them per project (here or in the dashboard: the project's Sandboxes › Agents); they sign in
  your sandboxes in that project only, for every agent that accepts them. A new project starts empty.
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

## Schedules (wake, run, sleep)

The platform can wake a paused sandbox on a timer, run a prompt or a shell command in it, and put
it back to sleep. You pay only while it is awake; files in `/workspace` carry over between runs.

```bash
lizard sandbox schedule <id> --every 5m --prompt "Continue the research in /workspace/research; append findings to notes.md"
lizard sandbox schedule <id> --every 10m --command "python3 /workspace/job.py"
lizard sandbox schedule <id> --cron "0 9 * * mon-fri" --tz Europe/Berlin --command "./report.sh"
lizard sandbox schedules [<id>]                 # list, with next and last run
lizard sandbox schedule-run <sch_id> --wait     # run now and print the result
lizard sandbox schedule-runs <sch_id> [-o]      # history; -o prints the latest output
lizard sandbox schedule-set <sch_id> --every 15m | --off | --on
lizard sandbox unschedule <sch_id>
```

- Each `--prompt` run starts a NEW agent conversation (on the project's agent credentials, as
  `sandbox prompt`). Keep state in files: tell the agent to read and update a notes file.
- `--command` runs in `/workspace` as root; success = exit code 0. Background processes it leaves
  end when the sandbox sleeps.
- Sleep is files only (fast; processes end, the next wake boots fresh).
- A sandbox that was already running when a run starts is left running afterwards.
- A run still going when the next is due makes that one skip. `--timeout` (default 10m) stops a
  run. Five failed runs in a row switch the schedule off (`schedules` shows why).
- Every 1m at most often. Prompt schedules need a key with no scopes (`ACCOUNT_SCOPE_REQUIRED`);
  `--command` schedules work with scoped keys. Not on every account yet: `SCHEDULES_NOT_ENABLED`.

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

- `lizard sandbox snapshot <sandbox-id> --name my-app` saves the sandbox's files (about a second whatever its RAM); sandboxes started from it boot fresh with them (memory and running processes are not saved). You and the members of its project can list, restore and delete it. A snapshot restores only in its own project and region. A Firecracker snapshot is ready as soon as the capture ends; the command waits until ready; `--no-wait` returns the queued capture.
- `lizard sandbox restore <snapshot-id> [--timeout <ms>]` starts a new sandbox from it in the snapshot's project (five-minute lifetime by default); naming any other project fails with 403 `SNAPSHOT_SCOPE`. `--volume <volume>` mounts a volume at `/workspace` in the restored sandbox (Firecracker snapshots of a sandbox that had no volume attached; the volume must be in the snapshot's project and region). `sandbox create --snapshot <id> [--volume <volume>]` also works; in a folder linked to another project, add `--project` with the snapshot's project. A snapshot restores at its source's size and bills flat at that size. `--size` with `--snapshot` is an error.
- `lizard sandbox snapshots --project <project>` lists a project's snapshots; `--mine` lists every snapshot you took. `sandbox snapshot-rm <id>` deletes the snapshot; sandboxes already started from it keep running.
- `lizard sandbox fork <sandbox-id> [-n <count>] [--timeout <ms>] --json` starts 1–100 live copies of a running sandbox: the platform pauses it for a moment, captures memory, processes and files once, and boots every copy from that capture; the source keeps its id and lifetime. Use it to fan out work from one prepared sandbox (tools installed, app loaded) without repeating the setup. Each copy is a sandbox start: it counts toward the running and start limits, runs at the source's size and bills like a new sandbox. The JSON is one entry per copy, `{ "sandbox": {…} }` or `{ "error": "…" }` (for example `Sandbox limit reached`); if any copy failed the command exits `1`, and the copies that did start keep running until you delete them. `--timeout` takes at least `1000`; leave it out to keep the source's lifetime. A sandbox with a volume attached can't be forked (409), and `fork` needs a running sandbox (409 for a paused one).
- `lizard sandbox pause <id>` (API `POST /api/sandboxes/<id>/pause` with no body, SDK `pause()`) saves files only: it stops billing in about a second whatever the sandbox's RAM, ends running processes, and `sandbox resume <id>` boots the sandbox fresh with its files, the same sandbox ID, published ports and remaining lifetime (`memoryRestored: false` in the resume JSON). Start your processes again after a resume. Pause freezes the remaining lifetime. Both support `--no-wait`.
- Disconnect clients and terminals and stop workspace writes before capturing or pausing. To reuse one snapshot across sandboxes that each keep their own data, snapshot a sandbox with no volume attached and pass `--volume` on each restore; a snapshot taken with a volume attached cannot take a different one.
