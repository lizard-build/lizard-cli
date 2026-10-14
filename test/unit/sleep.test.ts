import { describe, test, expect } from "vitest";
import { sleepPath, sleepChange } from "../../src/commands/sleep.js";

describe("sleepPath", () => {
  test("an app's setting lives on the app, a database's on its project", () => {
    expect(sleepPath({ id: "a1", kind: "app" }, "p1", { workspaceId: "w1" })).toBe("/api/apps/a1/sleep?workspaceId=w1");
    expect(sleepPath({ id: "d1", kind: "addon" }, "p1", {})).toBe("/api/projects/p1/addons/d1/sleep");
  });
});

describe("sleepChange", () => {
  test("no flag only reads", () => expect(sleepChange({})).toBeNull());
  test("--on, with or without --idle", () => {
    expect(sleepChange({ on: true })).toEqual({ enabled: true });
    expect(sleepChange({ on: true, idle: 30 })).toEqual({ enabled: true, idleMinutes: 30 });
  });
  test("--off", () => expect(sleepChange({ off: true })).toEqual({ enabled: false }));
  test("--idle alone changes the idle time of a service that sleeps, and refuses one that does not", () => {
    const on = { enabled: true, idleMinutes: 15, lastSleptAt: null, lastWokeAt: null, lastError: null, sleeps: 0, wakes: 0 };
    expect(sleepChange({ idle: 60 }, on)).toEqual({ enabled: true, idleMinutes: 60 });
    expect(() => sleepChange({ idle: 60 }, { ...on, enabled: false })).toThrow(/--on --idle/);
  });
  test("rejects both flags and an idle time out of range", () => {
    expect(() => sleepChange({ on: true, off: true })).toThrow(/not both/);
    expect(() => sleepChange({ on: true, idle: 2 })).toThrow(/5 and 1440/);
    expect(() => sleepChange({ on: true, idle: 2000 })).toThrow(/5 and 1440/);
  });
});
