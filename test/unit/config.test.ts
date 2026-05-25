import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  setProjectLink,
  getProjectLink,
  updateProjectLink,
} from "../../src/lib/config.js";

let tmpDir: string;
let originalLizardHome: string | undefined;

beforeEach(() => {
  originalLizardHome = process.env.LIZARD_HOME;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lizard-config-test-"));
  process.env.LIZARD_HOME = tmpDir;
});

afterEach(() => {
  if (originalLizardHome === undefined) delete process.env.LIZARD_HOME;
  else process.env.LIZARD_HOME = originalLizardHome;
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("ProjectLink schema", () => {
  test("setProjectLink + getProjectLink round-trip with workspaceId", () => {
    setProjectLink(
      {
        projectId: "proj_1",
        projectName: "demo",
        workspaceId: "ws_1",
        workspaceName: "acme-team",
      },
      tmpDir,
    );
    const got = getProjectLink(tmpDir);
    expect(got?.projectId).toBe("proj_1");
    expect(got?.workspaceId).toBe("ws_1");
    expect(got?.workspaceName).toBe("acme-team");
  });

  test("getProjectLink mirrors legacy appId/appName onto serviceId/serviceName", () => {
    const cfgFile = path.join(tmpDir, ".lizard", "config.json");
    fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
    fs.writeFileSync(
      cfgFile,
      JSON.stringify({
        projects: {
          [tmpDir]: {
            projectId: "proj_legacy",
            projectName: "legacy",
            appId: "app_old",
            appName: "old-app",
          },
        },
      }),
    );

    const link = getProjectLink(tmpDir);
    expect(link?.serviceId).toBe("app_old");
    expect(link?.serviceName).toBe("old-app");
    expect(link?.workspaceId).toBeUndefined();
  });

  test("updateProjectLink merges fields without dropping existing ones", () => {
    setProjectLink({ projectId: "proj_1", projectName: "demo" }, tmpDir);
    updateProjectLink({ workspaceId: "ws_filled", workspaceName: "filled" }, tmpDir);

    const got = getProjectLink(tmpDir);
    expect(got?.projectId).toBe("proj_1");
    expect(got?.projectName).toBe("demo");
    expect(got?.workspaceId).toBe("ws_filled");
    expect(got?.workspaceName).toBe("filled");
  });

  test("config.json without workspaceId still loads (legacy compat)", () => {
    const cfgFile = path.join(tmpDir, ".lizard", "config.json");
    fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
    fs.writeFileSync(
      cfgFile,
      JSON.stringify({
        projects: {
          [tmpDir]: { projectId: "proj_1", projectName: "demo" },
        },
      }),
    );

    const link = getProjectLink(tmpDir);
    expect(link?.projectId).toBe("proj_1");
    expect(link?.workspaceId).toBeUndefined();
  });
});
