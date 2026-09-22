import { describe, expect, it, vi } from "vitest";
import { registerOrRevert } from
  "../../src/services/shortcut/registerOrRevert";

describe("registerOrRevert", () => {
  it("updates last-known-good on success", async () => {
    const registered: string[] = [];
    const outcome = await registerOrRevert({
      binder: {
        register: async (h) => {
          registered.push(h);
        },
        unregister: async () => {},
      },
      currentlyBound: "Control+Shift+Space",
      lastKnownGood: "Control+Shift+Space",
      next: "Control+Alt+D",
    });
    expect(outcome).toEqual({
      active: "Control+Alt+D",
      lastKnownGood: "Control+Alt+D",
      ok: true,
    });
    expect(registered).toEqual(["Control+Alt+D"]);
  });

  it("re-binds last-known-good when next fails", async () => {
    const registered: string[] = [];
    const outcome = await registerOrRevert({
      binder: {
        register: async (h) => {
          if (h === "Control+Space") {
            throw new Error("already registered");
          }
          registered.push(h);
        },
        unregister: async () => {},
      },
      currentlyBound: "Control+Shift+Space",
      lastKnownGood: "Control+Shift+Space",
      next: "Control+Space",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.active).toBe("Control+Shift+Space");
      expect(outcome.attempted).toBe("Control+Space");
      expect(outcome.message).toContain("Kept prior shortcut");
    }
    expect(registered).toEqual(["Control+Shift+Space"]);
  });

  it("reports unbound when revert also fails", async () => {
    const outcome = await registerOrRevert({
      binder: {
        register: async () => {
          throw new Error("denied");
        },
        unregister: async () => {},
      },
      currentlyBound: null,
      lastKnownGood: "Control+Shift+Space",
      next: "Alt+Space",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.active).toBeNull();
      expect(outcome.message).toContain("gestures unbound");
    }
  });

  it("no-ops when already bound to next", async () => {
    const register = vi.fn();
    const outcome = await registerOrRevert({
      binder: { register, unregister: async () => {} },
      currentlyBound: "Control+A",
      lastKnownGood: "Control+A",
      next: "Control+A",
    });
    expect(outcome.ok).toBe(true);
    expect(register).not.toHaveBeenCalled();
  });
});
