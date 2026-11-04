# Lizard Functions (AWS Lambda-compatible)

Functions run your handler on demand: an HTTP call, a schedule, a queue message or an SDK
`invoke`. They are AWS Lambda-compatible (same handler signatures, same API, boto3 / AWS SDK
/ AWS CLI work with a Lizard endpoint), run in `us-east-1` (alias `us`) and `eu-west-lim-a`
(alias `eu`), and have no 15-minute limit (up to 24 hours).

Use a function for: an API endpoint or webhook (`--url`), a cron job (`--schedule`), a
scraper or a data job you call from code, work queued from elsewhere. Use `lizard up` (a
service) instead for a long-running server or anything with its own process manager.

## The whole loop, for agents

1. Write the handler file (Python, Node.js, TypeScript, Ruby, Go or Rust).
2. Run `lizard fn deploy <path> --json` (add `--schedule "every hour"` for a job, `--test` to call it once).
3. If `status` is not `"ready"`, run the `remediation` command exactly, then go back to 2.

Deploy is idempotent by name and checks that the code **starts** before it takes traffic: an
update that fails to start leaves the previous version serving (`serving.unchanged: true`).

## `lizard fn deploy`

```bash
lizard fn deploy scraper.py --schedule "every hour" --json
```

- **Source**: a file, a directory, or `-` (stdin, with `--name` and `--runtime`). Language,
  runtime and handler come from the source (`def handler(event, context)`,
  `export const handler = async (event) => ...`); `--handler module.function` overrides.
  TypeScript (`index.ts`), Go (`main.go` / `go.mod`) and Rust (`Cargo.toml`) are compiled on Lizard.
- **Packages, one rule** (the result's `packages.source` says which applied):
  1. a dependency file in the source (`requirements.txt`, `package.json` with dependencies,
     `Gemfile`, `go.mod`, `Cargo.toml`) is built into the code (`"file"`);
  2. otherwise `--packages a,b==1.2` (`"flag"`; `--packages ''` removes them);
  3. otherwise the packages the imports need are installed (`"imports"`: `bs4` ->
     `beautifulsoup4`, `PIL` -> `pillow`, `yaml` -> `pyyaml`...); `--no-infer` turns it off.
  Exact versions come back in `packages.resolved`; an unchanged list is not reinstalled
  (`"cache": "hit"`). A dependency file and `--packages` together fail with `PACKAGES_CONFLICT`;
  `import google` fails with `AMBIGUOUS_IMPORT` (name the package).
- **URL**: on by default for handlers that read HTTP events (`statusCode`, `rawPath`,
  `queryStringParameters`...); `--url` / `--no-url`; `--auth key` requires signed requests.
  The event is a function-URL event; return `{"statusCode": 200, "headers": {...}, "body": "..."}`.
- **Schedule**: `--schedule` takes `"every 15 minutes"`, `"hourly"`, `"daily at 09:00"`,
  `"weekdays at 9am"`, `"every monday at 18:30"`, a 5-field cron (`"*/5 * * * *"`),
  `rate(...)` or `cron(...)`; times are UTC; the result shows the expression and the next
  runs. `--schedule off` removes it.
- **Settings**: `--env KEY=VALUE` (repeatable), `--memory <MB>`, `--timeout <s>`,
  `--region us|eu`, `--project <id>`. `--test [event]` calls it after deploying (GET / for URL
  functions) and fails with `TEST_FAILED` if it errors. `--no-check` skips the start check.
- Every deploy that changes something is a numbered **version** (`version` in the result).

Success (`--json`, stdout):
```json
{"schemaVersion": 1, "status": "ready", "name": "scraper", "region": "us-east-1", "version": 1, "created": true,
 "changed": ["code", "packages", "schedule"], "runtime": "python3.13", "handler": "scraper.handler",
 "packages": {"source": "imports", "resolved": {"requests": "2.34.2", "beautifulsoup4": "4.15.0"}, "cache": "miss"},
 "check": {"kind": "start", "ok": true}, "url": null,
 "schedule": {"input": "every hour", "expression": "rate(1 hour)", "timezone": "UTC", "nextRuns": ["..."]},
 "next": [{"label": "run the schedule now", "command": "lizard fn invoke scraper --as-schedule --json"}]}
```

Failure (stdout empty, one JSON object on stderr, exit code below):
```json
{"schemaVersion": 1, "status": "failed", "phase": "check", "code": "IMPORT_ERROR",
 "error": "The function failed to start: No module named 'yaml'", "missing": ["pyyaml"],
 "serving": {"version": 1, "unchanged": true}, "logTail": "...",
 "remediation": "lizard fn deploy scraper.py --packages requests,pyyaml --json"}
```

Codes: `INVALID_INPUT`, `INVALID_SCHEDULE`, `NOT_FOUND`, `REGION_REQUIRED`, `SOURCE_TOO_LARGE`,
`IMPORT_ERROR` (with `missing`), `HANDLER_NOT_FOUND` (with `candidates`), `START_FAILED`,
`BUILD_FAILED` (with `logTail`), `PACKAGES_CONFLICT`, `AMBIGUOUS_IMPORT`, `TEST_FAILED`,
`BUSY`, `TIMEOUT`. Exit codes: 0 ready, 1 build / start / test failure, 2 not signed in,
3 invalid input or not found, 4 timeout.

## Calling and watching

```bash
lizard fn invoke <name> '{"url": "https://example.com"}' --json   # result (+ --logs)
lizard fn invoke <name> - < event.json
lizard fn invoke <name> '{}' --async                               # queued, returns at once
lizard fn invoke <name> --as-schedule --json                       # the event its schedule sends (run a job now)
lizard fn logs <name> --since 10m [-f]                             # print() / console.log output
lizard fn ls --json                                                # every region
lizard fn rm <name>
```

`invoke` exits 1 when the handler raised (the error JSON is printed, with the log).

## From code (AWS SDKs)

```bash
eval "$(lizard fn env --region us)"   # AWS_ACCESS_KEY_ID / SECRET / REGION / AWS_ENDPOINT_URL_LAMBDA ...
python3 -c "import boto3; print(boto3.client('lambda').invoke(FunctionName='scrape', Payload=b'{}')['Payload'].read())"
```

The SDKs and the AWS CLI pick the endpoint up from `AWS_ENDPOINT_URL_LAMBDA` (also SQS,
EventBridge, Scheduler, CloudWatch Logs). One key works in every region (each region has its
own endpoint: `https://functions-<region>.onlizard.com`). Inside a function, the AWS SDK is
already pointed at Lizard (it can invoke other functions, send to SQS, read Lizard S3).

## Recipes

Scraper with a URL:
```python
# scrape.py — lizard fn deploy scrape.py --packages requests,beautifulsoup4 --url
import json, requests
from bs4 import BeautifulSoup

def handler(event, context):
    url = (event.get("queryStringParameters") or {}).get("url") or event.get("url", "https://example.com")
    html = requests.get(url, timeout=15).text
    title = BeautifulSoup(html, "html.parser").title
    return {"statusCode": 200, "body": json.dumps({"url": url, "title": title.string if title else None})}
```

Webhook (Node.js):
```js
// index.mjs — lizard fn deploy index.mjs --url
export const handler = async (event) => {
  const body = JSON.parse(event.body || "{}");
  return { statusCode: 200, body: JSON.stringify({ received: body }) };
};
```

Cron job: `lizard fn deploy report.py --packages pandas --schedule "cron(0 8 * * ? *)" --env SLACK_URL=...`

Go: `lizard fn deploy main.go` with
```go
package main
import ("context"; "github.com/aws/aws-lambda-go/lambda")
func handler(ctx context.Context, e map[string]any) (map[string]any, error) { return map[string]any{"ok": true}, nil }
func main() { lambda.Start(handler) }
```

## Good to know

- The first function of a runtime in a region takes up to a minute (the runtime image is
  pulled once); later ones start in seconds. Idle functions pause and resume in about a second.
- Calls keep working during deploys and package installs: the new code starts next to the
  running one and takes over once it has started.
- Billing is the sandbox time the function's environments use (paused is free).
- The dashboard's Functions page shows the same functions (code editor, test, logs, packages).
