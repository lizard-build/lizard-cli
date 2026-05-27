import { describe, test, expect } from "vitest";
import {
  flattenPatch,
  validateNoRenameWithSecrets,
  validateSetPath,
  validateName,
  parseValue,
  setDeep,
  SERVICE_FIELDS,
} from "../../src/commands/service-set.js";

const ID = "app_123";
const NAME = "api";
const NAMES = new Map([[ID, NAME]]);

// ── flattenPatch: canonical flat shape ─────────────────────────────────────

describe("flattenPatch — flat canonical shape", () => {
  test("flat cfg fields land 1:1 on the wire", () => {
    const body = flattenPatch(
      {
        services: {
          [ID]: {
            buildCommand: "npm run build",
            startCommand: "node dist/index.js",
            preDeployCommand: "npm run migrate",
            healthcheckPath: "/health",
            healthcheckTimeoutMs: 5000,
            sourceType: "github",
            repoUrl: "https://github.com/acme/api",
            branch: "main",
            rootDirectory: "apps/api",
            watchPatterns: ["apps/api/**"],
            dockerfilePath: "apps/api/Dockerfile",
          },
        },
      },
      NAMES,
    );
    expect(body).toEqual({
      services: [
        {
          id: ID,
          buildCommand: "npm run build",
          startCommand: "node dist/index.js",
          preDeployCommand: "npm run migrate",
          healthcheckPath: "/health",
          healthcheckTimeoutMs: 5000,
          sourceType: "github",
          repoUrl: "https://github.com/acme/api",
          branch: "main",
          rootDirectory: "apps/api",
          watchPatterns: ["apps/api/**"],
          dockerfilePath: "apps/api/Dockerfile",
        },
      ],
    });
  });

  test("empty cfg yields service entry with id only (no implicit name)", () => {
    const body = flattenPatch({ services: { [ID]: {} } }, NAMES);
    expect(body.services).toEqual([{ id: ID }]);
    expect(body.services[0]).not.toHaveProperty("name");
  });

  test("each canonical field is independently round-trippable", () => {
    for (const f of SERVICE_FIELDS) {
      if (f === "name") continue;
      const cfg: Record<string, unknown> = {};
      cfg[f] = f === "healthcheckTimeoutMs" ? 1234 : f === "watchPatterns" ? ["x"] : "v";
      const body = flattenPatch({ services: { [ID]: cfg } }, NAMES);
      expect(body.services[0]).toMatchObject({ id: ID, [f]: cfg[f] });
    }
  });
});

// ── flattenPatch: legacy dotted prefixes are gone ──────────────────────────

describe("flattenPatch — legacy prefixed paths throw", () => {
  test.each([
    ["build", { buildCommand: "npm run build" }],
    ["deploy", { startCommand: "node dist/index.js" }],
    ["source", { type: "github" }],
  ])("nested '%s' block is rejected as unknown field", (prefix, inner) => {
    expect(() =>
      flattenPatch({ services: { [ID]: { [prefix]: inner } } }, NAMES),
    ).toThrow(/Unknown field '\w+' in service "api"/);
  });

  test("rejects arbitrary opaque keys with hint to --help", () => {
    expect(() =>
      flattenPatch({ services: { [ID]: { foo: "bar" } } }, NAMES),
    ).toThrow(/Unknown field 'foo'.*service set --help/s);
  });
});

// ── rename ─────────────────────────────────────────────────────────────────

describe("flattenPatch — rename", () => {
  test("emits 'name' only when it differs from current", () => {
    const body = flattenPatch(
      { services: { [ID]: { name: "api-v2" } } },
      NAMES,
    );
    expect(body.services).toEqual([{ id: ID, name: "api-v2" }]);
  });

  test("equal name is dropped (no fake audit-log churn)", () => {
    const body = flattenPatch(
      { services: { [ID]: { name: NAME, buildCommand: "x" } } },
      NAMES,
    );
    expect(body.services[0]).not.toHaveProperty("name");
    expect(body.services[0]).toMatchObject({ id: ID, buildCommand: "x" });
  });

  test("invalid new name throws before send", () => {
    expect(() =>
      flattenPatch({ services: { [ID]: { name: "Foo Bar" } } }, NAMES),
    ).toThrow(/Invalid 'name'.*lowercase/);
    expect(() =>
      flattenPatch({ services: { [ID]: { name: "-leadinghyphen" } } }, NAMES),
    ).toThrow(/Invalid 'name'/);
    expect(() =>
      flattenPatch({ services: { [ID]: { name: "x".repeat(41) } } }, NAMES),
    ).toThrow(/40 characters or fewer/);
  });

  test("unknown service id throws with clear message", () => {
    expect(() =>
      flattenPatch(
        { services: { ["app_does_not_exist"]: { buildCommand: "x" } } },
        NAMES,
      ),
    ).toThrow(/no longer exists/);
  });
});

// ── variables / secrets namespaces ─────────────────────────────────────────

describe("flattenPatch — variables and secrets", () => {
  test("variables.<KEY>=v lands in secrets.services[<name>]", () => {
    const body = flattenPatch(
      { services: { [ID]: { variables: { PORT: "3000" } } } },
      NAMES,
    );
    expect(body.services[0]).toEqual({ id: ID });
    expect(body.secrets).toEqual({ services: { [NAME]: { PORT: "3000" } } });
  });

  test("variables.<KEY>.value template form unwraps to its string", () => {
    const body = flattenPatch(
      {
        services: {
          [ID]: {
            variables: { DB_URL: { value: "${{ postgres.DATABASE_URL }}" } },
          },
        },
      },
      NAMES,
    );
    expect(body.secrets!.services[NAME].DB_URL).toBe(
      "${{ postgres.DATABASE_URL }}",
    );
  });

  test("variables.<KEY>=null deletes (passed through as null)", () => {
    const body = flattenPatch(
      { services: { [ID]: { variables: { OLD: null } } } },
      NAMES,
    );
    expect(body.secrets!.services[NAME]).toEqual({ OLD: null });
  });

  test("top-level sharedVariables → secrets.shared", () => {
    const body = flattenPatch(
      {
        services: { [ID]: {} },
        sharedVariables: { LOG_LEVEL: "debug" },
      },
      NAMES,
    );
    expect(body.secrets!.shared).toEqual({ LOG_LEVEL: "debug" });
  });

  test("explicit top-level secrets.services and secrets.shared pass through and merge", () => {
    const body = flattenPatch(
      {
        services: { [ID]: { variables: { A: "1" } } },
        secrets: {
          services: { [NAME]: { B: "2" } },
          shared: { GLOBAL: "g" },
        },
      },
      NAMES,
    );
    expect(body.secrets!.services[NAME]).toEqual({ A: "1", B: "2" });
    expect(body.secrets!.shared).toEqual({ GLOBAL: "g" });
  });
});

// ── rename + secrets guard ─────────────────────────────────────────────────

describe("validateNoRenameWithSecrets", () => {
  test("rename + per-service secrets → throws with split-call hint", () => {
    const body = flattenPatch(
      {
        services: { [ID]: { name: "api-v2", variables: { K: "v" } } },
      },
      NAMES,
    );
    expect(() => validateNoRenameWithSecrets(body, NAMES)).toThrow(
      /rename.*secret updates.*Split into two calls/s,
    );
  });

  test("rename alone is fine", () => {
    const body = flattenPatch(
      { services: { [ID]: { name: "api-v2" } } },
      NAMES,
    );
    expect(() => validateNoRenameWithSecrets(body, NAMES)).not.toThrow();
  });

  test("rename + only shared secrets is fine (shared isn't name-keyed)", () => {
    const body = flattenPatch(
      {
        services: { [ID]: { name: "api-v2" } },
        sharedVariables: { LOG_LEVEL: "debug" },
      },
      NAMES,
    );
    expect(() => validateNoRenameWithSecrets(body, NAMES)).not.toThrow();
  });

  test("secrets without rename is fine", () => {
    const body = flattenPatch(
      { services: { [ID]: { variables: { K: "v" } } } },
      NAMES,
    );
    expect(() => validateNoRenameWithSecrets(body, NAMES)).not.toThrow();
  });
});

// ── --set path validation ──────────────────────────────────────────────────

describe("validateSetPath", () => {
  test.each(SERVICE_FIELDS)("accepts canonical field '%s'", (f) => {
    expect(() => validateSetPath(f)).not.toThrow();
  });

  test.each([
    "variables.PORT",
    "variables.DB_URL.value",
    "variables.A_LONG_KEY_123",
  ])("accepts variables form '%s'", (path) => {
    expect(() => validateSetPath(path)).not.toThrow();
  });

  test.each([
    "build.buildCommand",
    "deploy.startCommand",
    "deploy.buildCommand",
    "deploy.preDeployCommand",
    "source.type",
    "source.repoUrl",
    "source.branch",
  ])("rejects legacy prefixed path '%s'", (path) => {
    expect(() => validateSetPath(path)).toThrow(/Unknown --set field/);
  });

  test("rejects arbitrary typos with --help hint", () => {
    expect(() => validateSetPath("buld.buildCommand")).toThrow(
      /Unknown --set field.*service set --help/s,
    );
    expect(() => validateSetPath("foo")).toThrow(/Unknown --set field/);
  });

  test("rejects malformed variables paths", () => {
    expect(() => validateSetPath("variables")).toThrow(/Unknown --set field/);
    expect(() => validateSetPath("variables.")).toThrow(/Invalid --set path/);
    expect(() => validateSetPath("variables.K.notvalue")).toThrow(
      /Invalid --set path/,
    );
    expect(() => validateSetPath("variables.K.value.extra")).toThrow(
      /Invalid --set path/,
    );
  });
});

// ── validateName mirror of backend ─────────────────────────────────────────

describe("validateName", () => {
  test.each(["api", "api-v2", "x", "a1", "my-cool-service-99"])(
    "accepts valid name '%s'",
    (n) => {
      expect(validateName(n)).toBeNull();
    },
  );

  test.each([
    ["", /required/],
    ["x".repeat(41), /40 characters or fewer/],
    ["Api", /lowercase/],
    ["-api", /lowercase/],
    ["api-", /lowercase/],
    ["api_v2", /lowercase/],
    ["api/v2", /lowercase/],
    ["api v2", /lowercase/],
  ])("rejects '%s' with reason matching %s", (n, re) => {
    const msg = validateName(n);
    expect(msg).not.toBeNull();
    expect(msg!).toMatch(re);
  });
});

// ── parseValue ──────────────────────────────────────────────────────────────

describe("parseValue", () => {
  test("healthcheckTimeoutMs coerces to number", () => {
    expect(parseValue("healthcheckTimeoutMs", "5000")).toBe(5000);
    expect(() => parseValue("healthcheckTimeoutMs", "fast")).toThrow(
      /expects a number/,
    );
  });

  test("watchPatterns: JSON array form", () => {
    expect(parseValue("watchPatterns", '["src/**","apps/api/**"]')).toEqual([
      "src/**",
      "apps/api/**",
    ]);
  });

  test("watchPatterns: comma-separated form", () => {
    expect(parseValue("watchPatterns", "src/**, apps/api/**, ")).toEqual([
      "src/**",
      "apps/api/**",
    ]);
  });

  test("plain string field passes through as-is (preserves whitespace)", () => {
    expect(parseValue("startCommand", "node dist/index.js")).toBe(
      "node dist/index.js",
    );
  });

  test("JSON-shaped string is parsed when valid, kept raw on parse fail", () => {
    expect(parseValue("repoUrl", '{"a":1}')).toEqual({ a: 1 });
    expect(parseValue("repoUrl", "{not json}")).toBe("{not json}");
  });
});

// ── setDeep ─────────────────────────────────────────────────────────────────

describe("setDeep", () => {
  test("writes a flat key", () => {
    const o: any = {};
    setDeep(o, "buildCommand", "foo");
    expect(o).toEqual({ buildCommand: "foo" });
  });

  test("creates nested objects as needed", () => {
    const o: any = {};
    setDeep(o, "variables.PORT", "3000");
    setDeep(o, "variables.DB_URL.value", "x");
    expect(o).toEqual({
      variables: { PORT: "3000", DB_URL: { value: "x" } },
    });
  });
});
