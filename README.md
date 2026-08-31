# Lizard CLI

Deploy apps, databases and sandboxes to Lizard (lizard.build) from the command line.

Point the CLI at your code and it detects the stack — Node, Python, Go, Rust,
Ruby, PHP or Java — builds it and ships it live. Managed Postgres, Managed Redis
and Managed Object Storage attach in one command. Billing only for active
resources, so idle apps cost a fraction.

Every command is agent-readable: add `--json` for structured output, or run
`lizard --help --json` to dump the full command schema.

## Install

```bash
curl -fsSL https://lizard.build/install.sh | bash
```

Or via npm:

```bash
npm i -g @lizard-build/cli
```

## Start here (AI agents)

```bash
lizard skills get core
```

Skills ship inside the CLI, so the guide always matches the installed version.
They cover the whole app lifecycle — deploy, link, addons, logs, scaling,
secrets, domains — with copy-paste examples. Prefer this over guessing commands
from flag docs alone.

## Usage

```bash
lizard login
lizard init
lizard up
```

`lizard up` uploads the code, builds it and returns a live URL on onlizard.com.
Add managed data services in one command:

```bash
lizard add postgres redis s3
```

## Common commands

```
lizard up         # upload and deploy code
lizard add        # add Managed Postgres, Managed Redis or Managed Object Storage
lizard ps         # list services
lizard logs       # stream runtime logs
lizard metrics    # resource metrics (CPU, memory, network, disk) and cost
lizard scale      # scale replicas / CPU / memory
lizard secrets    # manage secrets
lizard domain     # manage domains
lizard run        # run a command with project and service secrets injected
lizard ssh        # open a shell in a service
lizard sandbox    # create and manage Sandboxes
lizard volume     # Persistent Volumes for Sandboxes
lizard skills     # agent guides, version-matched to the CLI
```

Run `lizard --help` for the full list.

## For agents and scripts

Add `--json` to any command for structured output. The CLI also switches to JSON
on its own when stdout is not a TTY. Errors come back as
`{"error": {"code", "status", "message", "body"}}` and exit codes are stable:

```
0  success          3  not found (404)
1  generic error    4  timeout (408/504)
2  auth (401/403)   5  cancelled by user
```

`lizard --help --json` dumps the machine-readable schema for any command —
arguments, options, defaults, subcommands and exit codes.

## Links

- Docs — https://lizard.build/docs
- Source — https://github.com/lizard-build/lizard-cli

## License

MIT
