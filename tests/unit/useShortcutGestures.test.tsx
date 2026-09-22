import { act, renderHook, waitFor } from "@testing-library/react";
import { isTauri } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialState } from "../../src/app/initialState";
import {
  useShortcutGestures,
  type GestureDogfoodBridge,
} from "../../src/app/useShortcutGestures";
import type {
  DictationLifecycle,
  SetupLifecycle,
} from "../../src/services/contracts";
import type { AppState } from "../../src/app/state";
import type { RegisterOutcome } from
  "../../src/services/shortcut/registerOrRevert";
import type { OverlayBridge } from
  "../../src/services/shortcut/overlayBridge";

const mocks = vi.hoisted(() => ({
  createNativeShortcutController: vi.fn(),
  createOverlayBridge: vi.fn(),
}));

vi.mock("../../src/services/shortcut", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../src/services/shortcut")
  >();
  return {
    ...actual,
    createNativeShortcutController: (
      ...args: Parameters<typeof actual.createNativeShortcutController>
    ) => mocks.createNativeShortcutController(...args),
    createOverlayBridge: (
      ...args: Parameters<typeof actual.createOverlayBridge>
    ) => mocks.createOverlayBridge(...args),
  };
});

function shortcutEvent(type: "keydown" | "keyup") {
  return new KeyboardEvent(type, {
    bubbles: true,
    code: "Space",
    ctrlKey: true,
    key: " ",
    shiftKey: true,
  });
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}

function makeDictation(): DictationLifecycle {
  return {
    cancel: vi.fn(),
    complete: vi.fn(),
    fail: vi.fn(),
    finish: vi.fn(),
    holdProcessing: vi.fn(),
    retry: vi.fn(),
    speech: vi.fn(),
    start: vi.fn(),
  };
}

function makeSetup(): SetupLifecycle {
  return {
    replace: vi.fn(),
    reopen: vi.fn(),
    update: vi.fn(),
  };
}

function makeDogfood(
  overrides: Partial<GestureDogfoodBridge> = {},
): GestureDogfoodBridge {
  return {
    cancel: overrides.cancel ?? vi.fn(),
    phase: overrides.phase ?? "idle",
    start: overrides.start ?? vi.fn().mockResolvedValue(undefined),
    stop: overrides.stop ?? vi.fn().mockResolvedValue(undefined),
  };
}

function makeOptions(overrides: {
  dictation?: DictationLifecycle;
  dogfood?: ReturnType<typeof makeDogfood>;
  now?: () => number;
  onShortcutError?: (message: string) => void;
  state?: AppState;
} = {}) {
  return {
    dictation: overrides.dictation ?? makeDictation(),
    dogfood: overrides.dogfood ?? makeDogfood(),
    now: overrides.now ?? (() => 0),
    onboardingOpen: false,
    onShortcutError: overrides.onShortcutError ?? vi.fn(),
    setup: makeSetup(),
    shortcutOpen: false,
    state: overrides.state ?? createInitialState(0),
  };
}

function makeNativeController() {
  return {
    activeHotkey: vi.fn().mockReturnValue("Control+Shift+Space"),
    dispose: vi.fn().mockResolvedValue(undefined),
    lastKnownGood: vi.fn().mockReturnValue("Control+Shift+Space"),
    resetPartial: vi.fn(),
    setContext: vi.fn(),
    setShortcut: vi.fn<(settingsShortcut: string) => Promise<RegisterOutcome>>()
      .mockResolvedValue({
        active: "Control+Shift+Space",
        lastKnownGood: "Control+Shift+Space",
        ok: true as const,
      }),
  };
}

function makeOverlay(): OverlayBridge {
  return {
    dispose: vi.fn().mockResolvedValue(undefined),
    sync: vi.fn().mockResolvedValue(undefined),
  };
}

describe("useShortcutGestures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setVisibility("visible");
    vi.mocked(isTauri).mockReturnValue(false);
  });

  afterEach(() => {
    setVisibility("visible");
    vi.useRealTimers();
    vi.mocked(isTauri).mockReturnValue(false);
  });

  describe("native mode focus survival", () => {
    it("does not resetPartial on visibilitychange or pagehide", async () => {
      vi.mocked(isTauri).mockReturnValue(true);
      const native = makeNativeController();
      const overlay = makeOverlay();
      mocks.createNativeShortcutController.mockReturnValue(native);
      mocks.createOverlayBridge.mockReturnValue(overlay);

      const { unmount } = renderHook(() => useShortcutGestures(makeOptions()));

      await waitFor(() => {
        expect(native.setShortcut).toHaveBeenCalled();
      });
      native.resetPartial.mockClear();

      act(() => {
        setVisibility("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new Event("pagehide"));
      });

      expect(native.resetPartial).not.toHaveBeenCalled();
      unmount();
    });
  });

  describe("document / mock mode", () => {
    it("resets partial hold on document hide (missed-keyup safety)", () => {
      vi.mocked(isTauri).mockReturnValue(false);
      vi.useFakeTimers();
      let now = 0;
      const dictation = makeDictation();
      const state: AppState = {
        ...createInitialState(0),
        dictation: {
          kind: "listening",
          runId: 1,
          waveform: "speaking",
        },
      };
      // Stable options so the document controller is not recreated mid-hold.
      const options = makeOptions({
        dictation,
        now: () => now,
        state,
      });
      const { unmount } = renderHook(() => useShortcutGestures(options));

      act(() => {
        document.dispatchEvent(shortcutEvent("keydown"));
      });
      now = 320;
      act(() => {
        vi.advanceTimersByTime(320);
      });
      // Already listening — start ignored; machine still entered holding.
      expect(dictation.start).not.toHaveBeenCalled();

      act(() => {
        setVisibility("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
        document.dispatchEvent(shortcutEvent("keyup"));
      });
      // Without hide-reset, keyup would emit hold-finish → finish(runId).
      expect(dictation.finish).not.toHaveBeenCalled();

      unmount();
    });
  });

  describe("boot / Settings setShortcut", () => {
    it("does not double-setShortcut the same combo on mount", async () => {
      vi.mocked(isTauri).mockReturnValue(true);
      const native = makeNativeController();
      const overlay = makeOverlay();
      mocks.createNativeShortcutController.mockReturnValue(native);
      mocks.createOverlayBridge.mockReturnValue(overlay);

      const combo = "Ctrl + Shift + Space";
      const options = makeOptions({
        state: {
          ...createInitialState(0),
          settings: {
            ...createInitialState(0).settings,
            shortcut: combo,
          },
        },
      });

      const { rerender, unmount } = renderHook(
        (props) => useShortcutGestures(props),
        { initialProps: options },
      );

      await waitFor(() => {
        expect(native.setShortcut).toHaveBeenCalledTimes(1);
      });
      expect(native.setShortcut).toHaveBeenCalledWith(combo);

      // Same shortcut re-render must not rebind.
      rerender({ ...options });
      await act(async () => {
        await Promise.resolve();
      });
      expect(native.setShortcut).toHaveBeenCalledTimes(1);

      unmount();
    });

    it("rebinds when Settings shortcut changes to a different combo", async () => {
      vi.mocked(isTauri).mockReturnValue(true);
      const native = makeNativeController();
      const overlay = makeOverlay();
      mocks.createNativeShortcutController.mockReturnValue(native);
      mocks.createOverlayBridge.mockReturnValue(overlay);

      // Keep now / onShortcutError identity stable so only the Settings
      // effect rebinds (mount effect owns the initial bind).
      const now = () => 0;
      const onShortcutError = vi.fn();
      const baseState = createInitialState(0);
      const first = makeOptions({
        now,
        onShortcutError,
        state: {
          ...baseState,
          settings: {
            ...baseState.settings,
            shortcut: "Ctrl + Shift + Space",
          },
        },
      });

      const { rerender, unmount } = renderHook(
        (props) => useShortcutGestures(props),
        { initialProps: first },
      );

      await waitFor(() => {
        expect(native.setShortcut).toHaveBeenCalledTimes(1);
      });

      native.setShortcut.mockResolvedValue({
        active: "Control+Shift+F",
        lastKnownGood: "Control+Shift+F",
        ok: true as const,
      });

      rerender({
        ...first,
        state: {
          ...baseState,
          settings: {
            ...baseState.settings,
            shortcut: "Ctrl + Shift + F",
          },
        },
      });
      await waitFor(() => {
        expect(native.setShortcut).toHaveBeenCalledTimes(2);
      });
      expect(native.setShortcut).toHaveBeenLastCalledWith("Ctrl + Shift + F");

      unmount();
    });
  });

  describe("product gesture → dogfood delivery", () => {
    it("hold-start calls dogfood.start and dictation.start (snapshot at start)", () => {
      vi.mocked(isTauri).mockReturnValue(false);
      vi.useFakeTimers();
      let now = 0;
      const dictation = makeDictation();
      const dogfood = makeDogfood();
      const options = makeOptions({
        dictation,
        dogfood,
        now: () => now,
      });
      const { unmount } = renderHook(() => useShortcutGestures(options));

      act(() => {
        document.dispatchEvent(shortcutEvent("keydown"));
      });
      now = 320;
      act(() => {
        vi.advanceTimersByTime(320);
      });

      expect(dictation.start).toHaveBeenCalledOnce();
      expect(vi.mocked(dogfood.start)).toHaveBeenCalledOnce();
      expect(vi.mocked(dogfood.stop)).not.toHaveBeenCalled();
      expect(dictation.complete).not.toHaveBeenCalled();

      unmount();
    });

    it("hold-finish calls dogfood.stop and clears overlay, not synthetic complete", async () => {
      vi.mocked(isTauri).mockReturnValue(false);
      vi.useFakeTimers();
      let now = 0;
      const dictation = makeDictation();
      const dogfood = makeDogfood();
      // Mutable state so finish sees listening after start.
      const state: AppState = {
        ...createInitialState(0),
        dictation: { kind: "ready" },
      };
      const options = makeOptions({
        dictation,
        dogfood,
        now: () => now,
        state,
      });

      // Simulate dictation.start mutating app state (mock service would).
      vi.mocked(dictation.start).mockImplementation(() => {
        state.dictation = {
          kind: "listening",
          runId: 7,
          waveform: "silent",
        };
      });
      vi.mocked(dictation.cancel).mockImplementation((runId) => {
        state.dictation = { kind: "cancelled", runId };
      });

      const { unmount } = renderHook(() => useShortcutGestures(options));

      act(() => {
        document.dispatchEvent(shortcutEvent("keydown"));
      });
      now = 320;
      act(() => {
        vi.advanceTimersByTime(320);
      });
      expect(vi.mocked(dogfood.start)).toHaveBeenCalledOnce();

      act(() => {
        document.dispatchEvent(shortcutEvent("keyup"));
      });

      // Overlay torn down immediately on release (not holdProcessing).
      expect(dictation.cancel).toHaveBeenCalledWith(7);
      expect(dictation.holdProcessing).not.toHaveBeenCalled();
      await act(async () => {
        await Promise.resolve();
      });
      expect(vi.mocked(dogfood.stop)).toHaveBeenCalledOnce();
      expect(dictation.finish).not.toHaveBeenCalled();
      expect(dictation.complete).not.toHaveBeenCalled();
      expect(state.dictation.kind).toBe("cancelled");

      unmount();
    });

    it("hold-finish clears overlay even when dogfood.stop throws", async () => {
      vi.mocked(isTauri).mockReturnValue(false);
      vi.useFakeTimers();
      let now = 0;
      const dictation = makeDictation();
      const dogfood = makeDogfood({
        stop: vi.fn().mockRejectedValue(new Error("stop failed")),
      });
      const state: AppState = {
        ...createInitialState(0),
        dictation: { kind: "ready" },
      };
      const options = makeOptions({
        dictation,
        dogfood,
        now: () => now,
        state,
      });
      vi.mocked(dictation.start).mockImplementation(() => {
        state.dictation = {
          kind: "listening",
          runId: 3,
          waveform: "speaking",
        };
      });
      vi.mocked(dictation.cancel).mockImplementation((runId) => {
        state.dictation = { kind: "cancelled", runId };
      });

      const { unmount } = renderHook(() => useShortcutGestures(options));

      act(() => {
        document.dispatchEvent(shortcutEvent("keydown"));
      });
      now = 320;
      act(() => {
        vi.advanceTimersByTime(320);
      });
      act(() => {
        document.dispatchEvent(shortcutEvent("keyup"));
      });

      expect(dictation.cancel).toHaveBeenCalledWith(3);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(vi.mocked(dogfood.stop)).toHaveBeenCalledOnce();
      // finally path may cancel again; listening|processing must be gone
      expect(state.dictation.kind).toBe("cancelled");
      expect(dictation.holdProcessing).not.toHaveBeenCalled();

      unmount();
    });

    it("dogfood cancel/error phase clears listening overlay", async () => {
      vi.mocked(isTauri).mockReturnValue(false);
      const dictation = makeDictation();
      const dogfood = makeDogfood({ phase: "recording" });
      const state: AppState = {
        ...createInitialState(0),
        dictation: {
          kind: "listening",
          runId: 9,
          waveform: "speaking",
        },
      };
      const options = makeOptions({
        dictation,
        dogfood,
        state,
      });
      vi.mocked(dictation.cancel).mockImplementation((runId) => {
        state.dictation = { kind: "cancelled", runId };
      });

      const { rerender, unmount } = renderHook(
        (props) => useShortcutGestures(props),
        { initialProps: options },
      );

      rerender({
        ...options,
        dogfood: { ...dogfood, phase: "cancelled" },
        state,
      });
      await waitFor(() => {
        expect(dictation.cancel).toHaveBeenCalledWith(9);
      });
      expect(state.dictation.kind).toBe("cancelled");

      // error terminal likewise
      state.dictation = {
        kind: "processing",
        completion: "held",
        runId: 10,
      };
      vi.mocked(dictation.cancel).mockClear();
      rerender({
        ...options,
        dogfood: { ...dogfood, phase: "error" },
        state,
      });
      await waitFor(() => {
        expect(dictation.cancel).toHaveBeenCalledWith(10);
      });

      unmount();
    });


    it("two sequential hold→finish cycles clear overlay and stop both times", async () => {
      vi.mocked(isTauri).mockReturnValue(false);
      vi.useFakeTimers();
      let now = 0;
      let runSeq = 0;
      const dictation = makeDictation();
      const dogfood = makeDogfood();
      const state: AppState = {
        ...createInitialState(0),
        dictation: { kind: "ready" },
      };
      const options = makeOptions({
        dictation,
        dogfood,
        now: () => now,
        state,
      });
      vi.mocked(dictation.start).mockImplementation(() => {
        runSeq += 1;
        state.dictation = {
          kind: "listening",
          runId: runSeq,
          waveform: "speaking",
        };
      });
      vi.mocked(dictation.cancel).mockImplementation((runId) => {
        state.dictation = { kind: "cancelled", runId };
      });

      const { unmount } = renderHook(() => useShortcutGestures(options));

      for (let cycle = 1; cycle <= 3; cycle += 1) {
        vi.mocked(dogfood.start).mockClear();
        vi.mocked(dogfood.stop).mockClear();
        vi.mocked(dictation.cancel).mockClear();

        act(() => {
          document.dispatchEvent(shortcutEvent("keydown"));
        });
        now += 320;
        act(() => {
          vi.advanceTimersByTime(320);
        });
        expect(vi.mocked(dogfood.start)).toHaveBeenCalledOnce();
        expect(state.dictation.kind).toBe("listening");

        act(() => {
          document.dispatchEvent(shortcutEvent("keyup"));
        });
        expect(dictation.cancel).toHaveBeenCalled();
        await act(async () => {
          await Promise.resolve();
          await Promise.resolve();
        });
        expect(vi.mocked(dogfood.stop)).toHaveBeenCalledOnce();
        expect(state.dictation.kind).toBe("cancelled");
        expect(dictation.complete).not.toHaveBeenCalled();
      }

      unmount();
    });

    it("dogfood terminal via Home Stop clears leftover listening overlay", async () => {
      vi.mocked(isTauri).mockReturnValue(false);
      const dictation = makeDictation();
      const dogfood = makeDogfood({ phase: "recording" });
      const state: AppState = {
        ...createInitialState(0),
        dictation: {
          kind: "listening",
          runId: 42,
          waveform: "speaking",
        },
      };
      const options = makeOptions({
        dictation,
        dogfood,
        state,
      });
      vi.mocked(dictation.cancel).mockImplementation((runId) => {
        state.dictation = { kind: "cancelled", runId };
      });

      const { rerender, unmount } = renderHook(
        (props) => useShortcutGestures(props),
        { initialProps: options },
      );

      // Simulate Home Stop completing delivery without gesture finish.
      rerender({
        ...options,
        dogfood: { ...dogfood, phase: "success" },
        state,
      });
      await waitFor(() => {
        expect(dictation.cancel).toHaveBeenCalledWith(42);
      });
      expect(state.dictation.kind).toBe("cancelled");

      unmount();
    });

    it("new hold clears leftover listening when dogfood is idle", async () => {
      vi.mocked(isTauri).mockReturnValue(false);
      vi.useFakeTimers();
      let now = 0;
      const dictation = makeDictation();
      const dogfood = makeDogfood({ phase: "success" });
      const state: AppState = {
        ...createInitialState(0),
        dictation: {
          kind: "listening",
          runId: 11,
          waveform: "speaking",
        },
      };
      const options = makeOptions({
        dictation,
        dogfood,
        now: () => now,
        state,
      });
      vi.mocked(dictation.cancel).mockImplementation((runId) => {
        state.dictation = { kind: "cancelled", runId };
      });
      vi.mocked(dictation.start).mockImplementation(() => {
        state.dictation = {
          kind: "listening",
          runId: 12,
          waveform: "silent",
        };
      });

      const { unmount } = renderHook(() => useShortcutGestures(options));

      act(() => {
        document.dispatchEvent(shortcutEvent("keydown"));
      });
      now = 320;
      act(() => {
        vi.advanceTimersByTime(320);
      });

      expect(dictation.cancel).toHaveBeenCalledWith(11);
      expect(dictation.start).toHaveBeenCalledOnce();
      expect(vi.mocked(dogfood.start)).toHaveBeenCalledOnce();
      expect(state.dictation.kind).toBe("listening");
      expect(
        state.dictation.kind === "listening" && state.dictation.runId,
      ).toBe(12);

      unmount();
    });

    it("ignores hold-start while dogfood is already recording", () => {
      vi.mocked(isTauri).mockReturnValue(false);
      vi.useFakeTimers();
      let now = 0;
      const dictation = makeDictation();
      const dogfood = makeDogfood({ phase: "recording" });
      const options = makeOptions({
        dictation,
        dogfood,
        now: () => now,
      });
      const { unmount } = renderHook(() => useShortcutGestures(options));

      act(() => {
        document.dispatchEvent(shortcutEvent("keydown"));
      });
      now = 320;
      act(() => {
        vi.advanceTimersByTime(320);
      });

      expect(dictation.start).not.toHaveBeenCalled();
      expect(vi.mocked(dogfood.start)).not.toHaveBeenCalled();

      unmount();
    });
  });

});
