import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseAssignments } from "../../src/commands/sandbox-environments.js";
import { dailyCron, createScheduleBody } from "../../src/commands/sandbox-schedules.js";

afterEach(() => vi.restoreAllMocks());
const exits = () => vi.spyOn(process, "exit").mockImplementation(((c?: number) => { throw new Error(`exit ${c}`); }) as never);

describe("sandbox environment-set assignments", () => {
  it("takes KEY=VALUE, keeping = in the value", () => {
    expect(parseAssignments(["A=1", "URL=https://x/?a=b", "EMPTY="])).toEqual({ A: "1", URL: "https://x/?a=b", EMPTY: "" });
  });
  it("reads a .env file: comments, export, quotes; arguments win", () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lz-env-")), ".env");
    fs.writeFileSync(f, "# note\nexport A=1\nB=\"two words\"\n\nC='x'\n");
    expect(parseAssignments(["A=9"], f)).toEqual({ A: "9", B: "two words", C: "x" });
  });
  it("refuses an argument that is not KEY=VALUE", () => {
    exits(); vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => parseAssignments(["JUSTAKEY"])).toThrow("exit 2");
  });
});

describe("sandbox schedule --daily-at", () => {
  it("makes the cron the dashboard's Daily at makes", () => {
    expect(dailyCron("09:00", false)).toBe("0 9 * * *");
    expect(dailyCron("18:30", true)).toBe("30 18 * * 1-5");
  });
  it("refuses a time that is not HH:MM", () => {
    exits(); vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => dailyCron("9am", false)).toThrow("exit 2");
  });
  it("is a schedule's timing on sandbox create", () => {
    expect(createScheduleBody({ dailyAt: "07:15", weekdays: true, tz: "Europe/Berlin", command: "./report.sh" }))
      .toEqual({ cron: "15 7 * * 1-5", timezone: "Europe/Berlin", command: "./report.sh" });
  });
  it("refuses two timings at once", () => {
    exits(); vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => createScheduleBody({ every: "5m", dailyAt: "07:15", command: "x" })).toThrow("exit 2");
  });
});
