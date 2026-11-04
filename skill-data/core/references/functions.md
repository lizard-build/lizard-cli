# Lizard Functions (AWS Lambda-compatible)

Functions run your handler on demand: an HTTP call, a schedule, a queue message or an SDK
`invoke`. They are AWS Lambda-compatible (same handler signatures, same API, boto3 / AWS SDK
/ AWS CLI work with a Lizard endpoint), run in `us-east-1` (alias `us`) and `eu-west-lim-a`
(alias `eu`), and have no 15-minute limit (up to 24 hours).

Use a function for: an API endpoint or webhook (`--url`), a cron job (`--schedule`), a
scraper or a data job you call from code, work queued from elsewhere. Use `lizard up` (a
service) instead for a long-running server or anything with its own process manager.

## One command: `lizard fn deploy`

```bash
lizard fn deploy handler.py --packages requests,beautifulsoup4 --url --json
```

It creates the function or updates it (same name = update), installs the packages, waits
until the function is ready and prints its ARN, URL and how to call it. It is idempotent: an
unchanged file and unchanged packages are a no-op (about 2 s), a code change about 4 s.

- **Source**: a file (`handler.py`, `index.mjs`, `lambda_function.rb`, `main.go`,
  `bootstrap`), a directory, or `-` for stdin (with `--name` and `--runtime`).
- **Language and runtime**: from the file extension (Python 3.13, Node.js 22, Ruby 3.3) or
  `--runtime` (`python3.9`-`3.13`, `nodejs18.x`-`24.x`, `ruby3.2`-`3.4`, `java11/17/21`,
  `provided.al2023`). Go (`main.go` / `go.mod`) and Rust (`Cargo.toml`) are compiled on
  Lizard into an Amazon Linux 2023 `bootstrap`. TypeScript: compile to `.js` first.
- **Handler**: found in the source (`def lambda_handler(event, context)` / `handler`,
  `export const handler = async (event) => ...`); `--handler module.function` overrides.
- **Packages**:
  - `--packages a,b==1.2` preinstalls libraries in the function's own layer (Node.js, Python,
    Ruby): ready at every start, never reinstalled by code deploys, rebuilt only when the list
    changes. `--packages ""` removes them.
  - A `requirements.txt`, `package.json` (with dependencies) or `Gemfile` next to the file
    or in the directory is installed into the code instead (each deploy rebuilds).
  - For Go / Rust, `--packages` become `go get` / `cargo add` before the build.
  - Packages are installed on Lizard on the runtime's own Amazon Linux image, so binary
    wheels and native modules (numpy, pandas, Pillow, sharp, cryptography) match.
- **Settings**: `--env KEY=VALUE` (repeatable), `--memory <MB>` (up to 4096 on a 2 vCPU
  sandbox, 8192 on 4, more on 8), `--timeout <s>`, `--region us|eu`, `--project <id>`.
- `--url` gives it a public HTTPS URL (the event is API Gateway v2 / function URL shaped:
  `event["body"]`, `event["queryStringParameters"]`, `event["requestContext"]["http"]["method"]`;
  return `{"statusCode": 200, "headers": {...}, "body": "..."}` or any JSON).
- `--schedule "rate(5 minutes)"` or `--schedule "cron(0 9 * * ? *)"` runs it on a schedule.

## Calling and watching

```bash
lizard fn invoke <name> '{"url": "https://example.com"}' --json   # result (+ --logs)
lizard fn invoke <name> - < event.json
lizard fn invoke <name> '{}' --async                               # queued, returns at once
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
- Calls keep working during deploys and package installs (no downtime; a call at the moment
  of the switch can wait a second or two).
- Billing is the sandbox time the function's environments use (paused is free).
- The dashboard's Functions page shows the same functions (code editor, test, logs, packages).
