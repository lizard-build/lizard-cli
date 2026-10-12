## Execution rules

1. Prefer the `lizard` CLI. For anything it does not expose, ask the user: don't call the API directly.
2. Always pass `--json` on non-interactive calls. The CLI also switches to JSON by itself when stdout isn't a TTY.
3. For an unfamiliar command, run `lizard <cmd> --help --json` first: never guess flag shapes. See [Discovery](#discovery).
4. Resolve context before any change: `lizard status` shows the folder's link and its project. Confirm you are targeting the right project, service or sandbox.
5. For destructive actions (delete a service or sandbox, drop an addon, overwrite a project-wide secret, restart production), confirm with the user first. The CLI's own prompts only appear on a TTY.

## Discovery

The CLI has ~30 subcommands. Discover at runtime:

```
lizard --help --json                       # root + all commands + global flags + exit codes
lizard <cmd> --help --json                  # specific command schema
lizard <cmd> <sub> --help --json            # nested (e.g. `lizard service set --help --json`)
```

Returns `{ cli, version, command: { arguments, options, subcommands }, globalOptions, exitCodes }`.

## Sign-in

Every command that needs an account checks the sign-in first. Without one, in JSON mode it fails with exit code `2` and `error.code: "NOT_AUTHENTICATED"`, and `error.body.login` holds what you need to get the user signed in. `lizard login --json` prints the same object at the top level. It never waits and never opens a browser:

- `status: "pending"`: `authUrls` holds one link per sign-in method (`github`, `google`), and `authUrl` the one to use when only one applies. Ask the user how they sign in to Lizard and give them that link as a clickable URL. Someone with an account must use the same method as before: another method opens a second, empty account unless both share a verified email. Once they say the browser shows "CLI authorized", run the same command again (`nextCommand` when present); it picks the sign-in up. A link lasts 5 minutes; the next run prints a new one. Follow `instruction`.
- `status: "complete"` (from `lizard login` only): `username`, `email`, `source` (`browser`, `saved`, or `env` for `LIZARD_TOKEN` / `LIZARD_API_KEY`), `account` with the plan's `state` (`trial_available`, `subscription_required`, `trialing`, `active`, `past_due`, `credits`, `enterprise`, `not_owner`, `checkout_unavailable`, `unknown`), `billingUrl`, `payUrl` when a payment failed, and an `instruction` that says what to offer and what not to touch, plus `next` commands.

Never start a plan (`lizard billing start`) unless the user agrees. `lizard login` is safe to re-run: a signed-in machine skips straight to the plan. In CI nothing can be opened, so set `LIZARD_TOKEN` or `LIZARD_API_KEY`, or save a token on the machine with `printf '%s' "$TOKEN" | lizard login --token-stdin`. `lizard login --token <token>` works too, but the token lands in the process list and the shell history.

## Exit codes

- `0` success — continue
- `1` generic error — inspect message, surface to user
- `2` auth (401/403) — not signed in: give the user the link from `error.body.login` and run the command again once they have signed in (see [Sign-in](#sign-in)). No links in the body (CI, or the platform could not be reached)? Run `lizard login --json`, or ask for `LIZARD_TOKEN`.
- `3` not found (404) — wrong name / resource gone; verify with `lizard project list` / `lizard ps`
- `4` timeout — retry or report
- `5` cancelled by user — stop

## Default project

A command that works on a project takes it from `--project`, then from the folder's link, then falls back to the account's **default project**: the oldest live project in the personal workspace, which every account gets at sign-up (`<username>'s Project`). So `lizard sandbox create`, `lizard up`, `lizard logs` and the rest work in a folder that was never linked. They say so on stderr: `Project: <name> (your default)`.

- `lizard sandbox create` with no project lets the platform pick the default; its JSON carries `projectId`, `projectName` and `projectDefaulted: true`.
- `lizard up` links the unlinked folder to the default project first, then creates a service named after the folder, so the next `up` from that folder updates the same service. `lizard init --force` relinks it elsewhere.
- No default project (every project deleted): the old `No project linked. Run lizard init or pass --project <id>.` error.

## Billing

Billing belongs to the account; these commands take no project or service selector.

```sh
lizard billing --json              # plan, trial, this month's usage, next charge, billingUrl
lizard billing start --json        # Stripe Checkout link: the Pro trial, or Pro at once
lizard billing promo <code> --json # a longer trial with more trial usage
lizard billing open                # the Billing page
lizard metrics --cost --json       # spend per project; proCredits for Pro accounts
```

Pro costs $19/month, taxes included, and includes $19 of usage each month for
everything on the account; unused usage does not carry over. Usage above that is
pay as you go at the published rates, charged to the card as it builds up. A new
account starts with no plan. The 7-day trial includes $5 of usage; Checkout asks
for a card and charges nothing until the trial ends, then Pro is $19/month. When
the trial usage runs out, running resources pause and nothing new can be created
until Pro starts. Data is kept. Promo codes work only before the first payment.
Trial accounts run 1 replica per app and 5 sandboxes at once; after the first
paid invoice, 5 replicas per app and 100 sandboxes (paused sandboxes don't
count). Pro cards are changed or removed on the Billing page;
`lizard billing payment-methods remove` works only for Enterprise accounts.
Enterprise accounts pay as you go, invoiced monthly. There are no top-ups, no
auto top-up and no crypto or x402 payments.

When the account needs a plan or a payment, every create command (`up`, `add`,
`sandbox create`, `volume create`, `domain`, redeploys) fails with HTTP 402.
The JSON error has `code: "PAYMENT_REQUIRED"` (`"INSUFFICIENT_CREDITS"` from
older servers), a `message` to show the user as is (its last line is the link),
and `body.status` with the links:

| `body.status` | What to offer |
|---|---|
| `trial_available` | Start the trial: `body.subscribeUrl`, or `lizard billing start` |
| `subscription_required` | The trial is used: Start Pro ($19 today) the same way |
| `trial_credits_used` | Trial usage is used up: Start Pro now with `lizard billing start-now` or in Billing |
| `past_due` | A payment failed: pay the open invoice in Billing (`body.billingUrl`) |
| `paused` | Running resources are paused, data kept. `message` says why: trial usage used up (Start Pro now, as above) or a failed payment (pay the open invoice in Billing) |
| anything else | Show `message` and `body.billingUrl` |

Checkout and invoice pages open in the user's browser; you cannot finish them.
Give the user the link, never ask for card details in chat, and retry the
failed command after they say they are done. `start-now` (charges $19 now),
`cancel` and `resume` change what the user pays: run them only when the user
asks. Without a terminal, `start-now` and `cancel` need `-y`.
