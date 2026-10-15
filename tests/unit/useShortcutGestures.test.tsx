import { act, renderHook, waitFor } from '@testing-library/react';
import { isTauri } from '@tauri-apps/api/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialState } from '../../src/app/initialState';
import {
  useShortcutGestures,
  type GestureDogfoodBridge,
} from '../../src/app/useShortcutGestures';
import type { DogfoodPhase } from
  '../../src/services/stt/useDogfoodCapture';
import type {
  DictationLifecycle,
  SetupLifecycle,
} from '../../src/services/contracts';
import type { AppState } from '../../src/app/state';
import type { RegisterOutcome } from
  '../../src/services/shortcut/registerOrRevert';
import type { OverlayBridge } from
  '../../src/services/shortcut/overlayBridge';

const mocks = vi.hoisted(() => ({
  createNativeShortcutController: vi.fn(),
  createOverlayBridge: vi.fn(),
}));

vi.mock('../../src/services/shortcut', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../src/services/shortcut')
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

function shortcutEvent(type: 'keydown' | 'keyup') {
  return new KeyboardEvent(type, {
    bubbles: true,
    code: 'Space',
    ctrlKey: true,
    key: ' ',
    shiftKey: true,
  });
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', {
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
    phase: overrides.phase ?? 'idle',
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
    activeHotkey: vi.fn().mockReturnValue('Control+Shift+Space'),
    dispose: vi.fn().mockResolvedValue(undefined),
    lastKnownGood: vi.fn().mockReturnValue('Control+Shift+Space'),
    resetPartial: vi.fn(),
    setContext: vi.fn(),
    setShortcut: vi.fn<(settingsShortcut: string) => Promise<RegisterOutcome>>()
      .mockResolvedValue({
        active: 'Control+Shift+Space',
        lastKnownGood: 'Control+Shift+Space',
        ok: true as const,
      }),
  };
}

function makeOverlay(): OverlayBridge {
  return {
    dispose: vi.fn().mockResolvedValue(undefined),
    sync: vi.fn().mockResolvedValue(undefined),
    showResult: vi.fn().mockResolvedValue(undefined),
  };
}

describe('useShortcutGestures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setVisibility('visible');
    vi.mocked(isTauri).mockReturnValue(false);
  });

  afterEach(() => {
    setVisibility('visible');
    vi.useRealTimers();
    vi.mocked(isTauri).mockReturnValue(false);
  });

  describe('native mode focus survival', () => {
    it.each(['hold', 'latch'] as const)('%s finish stops before a listening commit', async (mode) => {
      vi.mocked(isTauri).mockReturnValue(true);
      const native = makeNativeController();
      mocks.createNativeShortcutController.mockReturnValue(native);
      mocks.createOverlayBridge.mockReturnValue(makeOverlay());
      const dogfood = makeDogfood();
      renderHook(() => useShortcutGestures(makeOptions({ dogfood })));
      await waitFor(() => expect(native.setShortcut).toHaveBeenCalled());
      const { onGesture } = mocks.createNativeShortcutController.mock.calls[0][0];
      act(() => { onGesture(`${mode}-start`); });
      act(() => { onGesture(`${mode}-finish`); });
      expect(dogfood.stop).toHaveBeenCalledOnce();
    });

    it('does not resetPartial on visibilitychange or pagehide', async () => {
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
        setVisibility('hidden');
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event('pagehide'));
      });

      expect(native.resetPartial).not.toHaveBeenCalled();
      unmount();
    });
  });

  describe('document / mock mode', () => {
    it('resets partial hold on document hide (missed-keyup safety)', () => {
      vi.mocked(isTauri).mockReturnValue(false);
      vi.useFakeTimers();
      let now = 0;
      const dictation = makeDictation();
      const state: AppState = {
        ...createInitialState(0),
        dictation: {
          kind: 'listening',
          runId: 1,
          waveform: 'speaking',
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
        document.dispatchEvent(shortcutEvent('keydown'));
      });
      now = 320;
      act(() => {
        vi.advanceTimersByTime(320);
      });
      // Leftover listening is force-cleared then a new start runs.
      expect(dictation.cancel).toHaveBeenCalled();
      expect(dictation.start).toHaveBeenCalledOnce();

      act(() => {
        setVisibility('hidden');
        document.dispatchEvent(new Event('visibilitychange'));
        document.dispatchEvent(shortcutEvent('keyup'));
      });
      // Document hide resets partial; never invent Inserted via finish().
      expect(dictation.finish).not.toHaveBeenCalled();

      unmount();
    });
  });

  describe('boot / Settings setShortcut', () => {
    it('does not double-setShortcut the same combo on mount', async () => {
      vi.mocked(isTauri).mockReturnValue(true);
      const native = makeNativeController();
      const overlay = makeOverlay();
      mocks.createNativeShortcutController.mockReturnValue(native);
      mocks.createOverlayBridge.mockReturnValue(overlay);

      const combo = 'Ctrl + Shift + Space';
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

    it('rebinds when Settings shortcut changes to a different combo', async () => {
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
            shortcut: 'Ctrl + Shift + Space',
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
        active: 'Control+Shift+F',
        lastKnownGood: 'Control+Shift+F',
        ok: true as const,
      });

      rerender({
        ...first,
        state: {
          ...baseState,
          settings: {
            ...baseState.settings,
            shortcut: 'Ctrl + Shift + F',
          },
        },
      });
      await waitFor(() => {
        expect(native.setShortcut).toHaveBeenCalledTimes(2);
      });
      expect(native.setShortcut).toHaveBeenLastCalledWith('Ctrl + Shift + F');

      unmount();
    });

    it('BUS-47: reverts settings.shortcut to the last good combo when registration fails', async () => {
      vi.mocked(isTauri).mockReturnValue(true);
      const native = makeNativeController();
      mocks.createNativeShortcutController.mockReturnValue(native);
      mocks.createOverlayBridge.mockReturnValue(makeOverlay());
      const onShortcutError = vi.fn();
      const onShortcutRevert = vi.fn();
      const baseState = createInitialState(0);
      const withShortcut = (shortcut: string) => ({
        ...baseState, settings: { ...baseState.settings, shortcut },
      });
      const first = { ...makeOptions({ now: () => 0, onShortcutError, state: withShortcut('Ctrl + Shift + Space') }), onShortcutRevert };
      const { rerender, unmount } = renderHook((props) => useShortcutGestures(props), { initialProps: first });
      await waitFor(() => expect(native.setShortcut).toHaveBeenCalledTimes(1));

      native.setShortcut.mockResolvedValue({
        active: 'Control+Shift+Space', attempted: 'Control+Alt+K',
        lastKnownGood: 'Control+Shift+Space', message: 'Taken.', ok: false as const,
      });
      rerender({ ...first, state: withShortcut('Ctrl + Alt + K') });
      await waitFor(() => expect(onShortcutRevert).toHaveBeenCalledWith('Ctrl + Shift + Space'));
      expect(onShortcutError).toHaveBeenCalledWith('⌃⌥K is in use by another app. Kept ⌃⇧Space.');

      // The reverted value doesn't trigger another registration.
      rerender({ ...first, state: withShortcut('Ctrl + Shift + Space') });
      await new Promise((r) => setTimeout(r, 10));
      expect(native.setShortcut).toHaveBeenCalledTimes(2);
      unmount();
    });
    it('BUS-47: a re-render with new callbacks while pending still reverts and reports', async () => {
      vi.mocked(isTauri).mockReturnValue(true);
      const native = makeNativeController();
      mocks.createNativeShortcutController.mockReturnValue(native);
      mocks.createOverlayBridge.mockReturnValue(makeOverlay());
      const errors: string[] = [];
      const reverts: string[] = [];
      const baseState = createInitialState(0);
      const withShortcut = (shortcut: string) => ({
        ...baseState, settings: { ...baseState.settings, shortcut },
      });
      // Fresh callback identities on every render, like an unmemoized announceError.
      const stable = makeOptions({ now: () => 0 });
      const props = (shortcut: string) => ({
        ...stable,
        onShortcutError: (m: string) => { errors.push(m); },
        state: withShortcut(shortcut),
        onShortcutRevert: (s: string) => { reverts.push(s); },
      });
      const { rerender, unmount } = renderHook((p) => useShortcutGestures(p), { initialProps: props('Ctrl + Shift + Space') });
      await waitFor(() => expect(native.setShortcut).toHaveBeenCalledTimes(1));

      let resolve!: (v: Awaited<ReturnType<typeof native.setShortcut>>) => void;
      native.setShortcut.mockReturnValue(new Promise((r) => { resolve = r; }));
      rerender(props('Ctrl + Alt + K'));
      await waitFor(() => expect(native.setShortcut).toHaveBeenCalledTimes(2));
      rerender(props('Ctrl + Alt + K')); // re-render while pending
      await act(async () => {
        resolve({ active: 'Control+Shift+Space', attempted: 'Control+Alt+K',
          lastKnownGood: 'Control+Shift+Space', message: 'Taken.', ok: false });
      });
      await waitFor(() => expect(reverts).toEqual(['Ctrl + Shift + Space']));
      expect(errors).toEqual(['⌃⌥K is in use by another app. Kept ⌃⇧Space.']);
      unmount();
    });
    it('BUS-47: fast A then B, A ok lands late, B refused: reverts to A (what native holds)', async () => {
      vi.mocked(isTauri).mockReturnValue(true);
      const native = makeNativeController();
      mocks.createNativeShortcutController.mockReturnValue(native);
      mocks.createOverlayBridge.mockReturnValue(makeOverlay());
      const reverts: string[] = [];
      const baseState = createInitialState(0);
      const stable = makeOptions({ now: () => 0 });
      const props = (shortcut: string) => ({
        ...stable,
        onShortcutRevert: (s: string) => { reverts.push(s); },
        state: { ...baseState, settings: { ...baseState.settings, shortcut } },
      });
      const { rerender, unmount } = renderHook((p) => useShortcutGestures(p), { initialProps: props('Ctrl + Shift + Space') });
      await waitFor(() => expect(native.setShortcut).toHaveBeenCalledTimes(1));

      let resolveA!: (v: RegisterOutcome) => void;
      let resolveB!: (v: RegisterOutcome) => void;
      native.setShortcut
        .mockReturnValueOnce(new Promise((r) => { resolveA = r; }))
        .mockReturnValueOnce(new Promise((r) => { resolveB = r; }));
      rerender(props('Ctrl + Alt + A'));
      await waitFor(() => expect(native.setShortcut).toHaveBeenCalledTimes(2));
      rerender(props('Ctrl + Alt + B')); // B cancels A's effect
      await waitFor(() => expect(native.setShortcut).toHaveBeenCalledTimes(3));
      await act(async () => {
        resolveA({ active: 'Control+Alt+A', lastKnownGood: 'Control+Alt+A', ok: true });
      });
      await act(async () => {
        resolveB({ active: 'Control+Alt+A', attempted: 'Control+Alt+B',
          lastKnownGood: 'Control+Alt+A', message: 'Taken.', ok: false });
      });
      await waitFor(() => expect(reverts).toEqual(['Ctrl + Alt + A']));
      unmount();
    });

    it('BUS-47: seeds the revert target from the boot outcome, not startup settings', async () => {
      vi.mocked(isTauri).mockReturnValue(true);
      const native = makeNativeController();
      native.setShortcut.mockResolvedValueOnce({ active: null, attempted: 'Control+Alt+Z',
        lastKnownGood: null, message: 'Boot taken.', ok: false });
      mocks.createNativeShortcutController.mockReturnValue(native);
      mocks.createOverlayBridge.mockReturnValue(makeOverlay());
      const reverts: string[] = [];
      const baseState = createInitialState(0);
      const stable = makeOptions({ now: () => 0 });
      const props = (shortcut: string) => ({
        ...stable,
        onShortcutRevert: (s: string) => { reverts.push(s); },
        state: { ...baseState, settings: { ...baseState.settings, shortcut } },
      });
      const { rerender, unmount } = renderHook((p) => useShortcutGestures(p), { initialProps: props('Ctrl + Alt + Z') });
      await waitFor(() => expect(native.setShortcut).toHaveBeenCalledTimes(1));
      native.setShortcut.mockResolvedValueOnce({ active: null, attempted: 'Control+Alt+K',
        lastKnownGood: null, message: 'Taken.', ok: false });
      rerender(props('Ctrl + Alt + K'));
      await waitFor(() => expect(native.setShortcut).toHaveBeenCalledTimes(2));
      await new Promise((r) => setTimeout(r, 10));
      expect(reverts).toEqual([]); // never back to the refused boot combo
      unmount();
    });
  });

  describe('product gesture → dogfood delivery', () => {
    it('hold-start calls dogfood.start and dictation.start (snapshot at start)', () => {
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
        document.dispatchEvent(shortcutEvent('keydown'));
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

    it('stops on release before the pending React listening commit', async () => {
      vi.useFakeTimers();
      let now = 0;
      const dogfood = makeDogfood();
      const options = makeOptions({ dogfood, now: () => now });
      const { rerender } = renderHook((props) => useShortcutGestures(props), {
        initialProps: options,
      });
      act(() => { document.dispatchEvent(shortcutEvent('keydown')); });
      now = 320;
      act(() => { vi.advanceTimersByTime(320); });
      act(() => { document.dispatchEvent(shortcutEvent('keyup')); });
      // No listening commit exists yet: target acquisition must not wait for it.
      expect(dogfood.stop).toHaveBeenCalledOnce();
      rerender({ ...options, state: { ...options.state, dictation: {
        kind: 'listening', runId: 91, waveform: 'silent',
      } } });
      await act(async () => { await Promise.resolve(); });
      expect(dogfood.stop).toHaveBeenCalledOnce();
    });

    it('hold-finish calls dogfood.stop and clears overlay, not synthetic complete', async () => {
      vi.mocked(isTauri).mockReturnValue(false);
      vi.useFakeTimers();
      let now = 0;
      const dictation = makeDictation();
      const dogfood = makeDogfood();
      // Mutable state so finish sees listening after start.
      const state: AppState = {
        ...createInitialState(0),
        dictation: { kind: 'ready' },
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
          kind: 'listening',
          runId: 7,
          waveform: 'silent',
        };
      });
      vi.mocked(dictation.cancel).mockImplementation((runId) => {
        state.dictation = { kind: 'cancelled', runId };
      });

      const { unmount } = renderHook(() => useShortcutGestures(options));

      act(() => {
        document.dispatchEvent(shortcutEvent('keydown'));
      });
      now = 320;
      act(() => {
        vi.advanceTimersByTime(320);
      });
      expect(vi.mocked(dogfood.start)).toHaveBeenCalledOnce();

      act(() => {
        document.dispatchEvent(shortcutEvent('keyup'));
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
      expect(state.dictation.kind).toBe('cancelled');

      unmount();
    });

    it('hold-finish clears overlay even when dogfood.stop throws', async () => {
      vi.mocked(isTauri).mockReturnValue(false);
      vi.useFakeTimers();
      let now = 0;
      const dictation = makeDictation();
      const dogfood = makeDogfood({
        stop: vi.fn().mockRejectedValue(new Error('stop failed')),
      });
      const state: AppState = {
        ...createInitialState(0),
        dictation: { kind: 'ready' },
      };
      const options = makeOptions({
        dictation,
        dogfood,
        now: () => now,
        state,
      });
      vi.mocked(dictation.start).mockImplementation(() => {
        state.dictation = {
          kind: 'listening',
          runId: 3,
          waveform: 'speaking',
        };
      });
      vi.mocked(dictation.cancel).mockImplementation((runId) => {
        state.dictation = { kind: 'cancelled', runId };
      });

      const { unmount } = renderHook(() => useShortcutGestures(options));

      act(() => {
        document.dispatchEvent(shortcutEvent('keydown'));
      });
      now = 320;
      act(() => {
        vi.advanceTimersByTime(320);
      });
      act(() => {
        document.dispatchEvent(shortcutEvent('keyup'));
      });

      expect(dictation.cancel).toHaveBeenCalledWith(3);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(vi.mocked(dogfood.stop)).toHaveBeenCalledOnce();
      // finally path may cancel again; listening|processing must be gone
      expect(state.dictation.kind).toBe('cancelled');
      expect(dictation.holdProcessing).not.toHaveBeenCalled();

      unmount();
    });

    it('dogfood cancel/error phase clears listening overlay', async () => {
      vi.mocked(isTauri).mockReturnValue(false);
      const dictation = makeDictation();
      const dogfood = makeDogfood({ phase: 'recording' });
      const state: AppState = {
        ...createInitialState(0),
        dictation: {
          kind: 'listening',
          runId: 9,
          waveform: 'speaking',
        },
      };
      const options = makeOptions({
        dictation,
        dogfood,
        state,
      });
      vi.mocked(dictation.cancel).mockImplementation((runId) => {
        state.dictation = { kind: 'cancelled', runId };
      });

      const { rerender, unmount } = renderHook(
        (props) => useShortcutGestures(props),
        { initialProps: options },
      );

      rerender({
        ...options,
        dogfood: { ...dogfood, phase: 'cancelled' },
        state,
      });
      await waitFor(() => {
        expect(dictation.cancel).toHaveBeenCalledWith(9);
      });
      expect(state.dictation.kind).toBe('cancelled');

      // error terminal likewise
      state.dictation = {
        kind: 'processing',
        completion: 'held',
        runId: 10,
      };
      vi.mocked(dictation.cancel).mockClear();
      rerender({
        ...options,
        dogfood: { ...dogfood, phase: 'error' },
        state,
      });
      await waitFor(() => {
        expect(dictation.cancel).toHaveBeenCalledWith(10);
      });

      unmount();
    });


    it('two sequential hold→finish cycles clear overlay and stop both times', async () => {
      vi.mocked(isTauri).mockReturnValue(false);
      vi.useFakeTimers();
      let now = 0;
      let runSeq = 0;
      const dictation = makeDictation();
      const dogfood = makeDogfood();
      const state: AppState = {
        ...createInitialState(0),
        dictation: { kind: 'ready' },
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
          kind: 'listening',
          runId: runSeq,
          waveform: 'speaking',
        };
      });
      vi.mocked(dictation.cancel).mockImplementation((runId) => {
        state.dictation = { kind: 'cancelled', runId };
      });

      const { unmount } = renderHook(() => useShortcutGestures(options));

      for (let cycle = 1; cycle <= 3; cycle += 1) {
        vi.mocked(dogfood.start).mockClear();
        vi.mocked(dogfood.stop).mockClear();
        vi.mocked(dictation.cancel).mockClear();

        act(() => {
          document.dispatchEvent(shortcutEvent('keydown'));
        });
        now += 320;
        act(() => {
          vi.advanceTimersByTime(320);
        });
        expect(vi.mocked(dogfood.start)).toHaveBeenCalledOnce();
        expect(state.dictation.kind).toBe('listening');

        act(() => {
          document.dispatchEvent(shortcutEvent('keyup'));
        });
        expect(dictation.cancel).toHaveBeenCalled();
        await act(async () => {
          await Promise.resolve();
          await Promise.resolve();
        });
        expect(vi.mocked(dogfood.stop)).toHaveBeenCalledOnce();
        expect(state.dictation.kind).toBe('cancelled');
        expect(dictation.complete).not.toHaveBeenCalled();
      }

      unmount();
    });

    it('dogfood terminal via Home Stop clears leftover listening overlay', async () => {
      vi.mocked(isTauri).mockReturnValue(false);
      const dictation = makeDictation();
      const dogfood = makeDogfood({ phase: 'recording' });
      const state: AppState = {
        ...createInitialState(0),
        dictation: {
          kind: 'listening',
          runId: 42,
          waveform: 'speaking',
        },
      };
      const options = makeOptions({
        dictation,
        dogfood,
        state,
      });
      vi.mocked(dictation.cancel).mockImplementation((runId) => {
        state.dictation = { kind: 'cancelled', runId };
      });

      const { rerender, unmount } = renderHook(
        (props) => useShortcutGestures(props),
        { initialProps: options },
      );

      // Simulate Home Stop completing delivery without gesture finish.
      rerender({
        ...options,
        dogfood: { ...dogfood, phase: 'success' },
        state,
      });
      await waitFor(() => {
        expect(dictation.cancel).toHaveBeenCalledWith(42);
      });
      expect(state.dictation.kind).toBe('cancelled');

      unmount();
    });

    it('new hold clears leftover listening when dogfood is idle', async () => {
      vi.mocked(isTauri).mockReturnValue(false);
      vi.useFakeTimers();
      let now = 0;
      const dictation = makeDictation();
      const dogfood = makeDogfood({ phase: 'success' });
      const state: AppState = {
        ...createInitialState(0),
        dictation: {
          kind: 'listening',
          runId: 11,
          waveform: 'speaking',
        },
      };
      const options = makeOptions({
        dictation,
        dogfood,
        now: () => now,
        state,
      });
      vi.mocked(dictation.cancel).mockImplementation((runId) => {
        state.dictation = { kind: 'cancelled', runId };
      });
      vi.mocked(dictation.start).mockImplementation(() => {
        state.dictation = {
          kind: 'listening',
          runId: 12,
          waveform: 'silent',
        };
      });

      const { unmount } = renderHook(() => useShortcutGestures(options));

      act(() => {
        document.dispatchEvent(shortcutEvent('keydown'));
      });
      now = 320;
      act(() => {
        vi.advanceTimersByTime(320);
      });

      expect(dictation.cancel).toHaveBeenCalledWith(11);
      expect(dictation.start).toHaveBeenCalledOnce();
      expect(vi.mocked(dogfood.start)).toHaveBeenCalledOnce();
      expect(state.dictation.kind).toBe('listening');
      expect(
        state.dictation.kind === 'listening' && state.dictation.runId,
      ).toBe(12);

      unmount();
    });

    it('force-stops leftover recording dogfood then starts a new hold', () => {
      vi.mocked(isTauri).mockReturnValue(false);
      vi.useFakeTimers();
      let now = 0;
      const dictation = makeDictation();
      const dogfood = makeDogfood({ phase: 'recording' });
      const state: AppState = {
        ...createInitialState(0),
        dictation: {
          kind: 'listening',
          runId: 7,
          waveform: 'speaking',
        },
      };
      const options = makeOptions({
        dictation,
        dogfood,
        now: () => now,
        state,
      });
      vi.mocked(dictation.cancel).mockImplementation((runId) => {
        state.dictation = { kind: 'cancelled', runId };
      });
      vi.mocked(dictation.start).mockImplementation(() => {
        state.dictation = {
          kind: 'listening',
          runId: 8,
          waveform: 'silent',
        };
      });
      const { unmount } = renderHook(() => useShortcutGestures(options));

      act(() => {
        document.dispatchEvent(shortcutEvent('keydown'));
      });
      now = 320;
      act(() => {
        vi.advanceTimersByTime(320);
      });

      // c9e0df5: do not silently ignore busy — abandon prior, start new.
      expect(dogfood.cancel).toHaveBeenCalledOnce();
      expect(dictation.cancel).toHaveBeenCalledWith(7);
      expect(dictation.start).toHaveBeenCalledOnce();
      expect(vi.mocked(dogfood.start)).toHaveBeenCalledOnce();
      expect(
        state.dictation.kind === 'listening' && state.dictation.runId,
      ).toBe(8);

      unmount();
    });
    it('second hold after a delivered session listens and finishes (terminal phase is not re-applied)', async () => {
      // Real app re-renders on every dispatch / phase change. After hold 1
      // delivers, dogfood.phase stays "success". Hold 2's listening commit
      // must NOT re-run the terminal teardown (dbe5748 regression: 2nd hold
      // showed no overlay, machine reset, release lost, Home stuck on Stop).
      vi.mocked(isTauri).mockReturnValue(false);
      vi.useFakeTimers();
      let now = 0;
      const clock = () => now;
      let runSeq = 0;
      let phase: DogfoodPhase = 'idle';
      const dictation = makeDictation();
      const dogfood = makeDogfood();
      const state: AppState = {
        ...createInitialState(0),
        dictation: { kind: 'ready' },
      };
      vi.mocked(dictation.start).mockImplementation(() => {
        runSeq += 1;
        state.dictation = {
          kind: 'listening',
          runId: runSeq,
          waveform: 'silent',
        };
      });
      vi.mocked(dictation.cancel).mockImplementation((runId) => {
        const d = state.dictation;
        if (
          (d.kind === 'listening' || d.kind === 'processing')
          && d.runId === runId
        ) {
          state.dictation = { kind: 'cancelled', runId };
        }
      });
      const props = () => makeOptions({
        dictation,
        dogfood: { ...dogfood, phase },
        now: clock,
        state: { ...state },
      });
      const { rerender, unmount } = renderHook(
        (p) => useShortcutGestures(p),
        { initialProps: props() },
      );
      const render = () => rerender(props());

      const holdAndRelease = async (expectedRun: number) => {
        act(() => {
          document.dispatchEvent(shortcutEvent('keydown'));
        });
        now += 320;
        act(() => {
          vi.advanceTimersByTime(320);
        });
        expect(state.dictation.kind).toBe('listening');
        // Commit the listening run (phase may still be a stale terminal).
        render();
        expect(dictation.cancel).not.toHaveBeenCalledWith(expectedRun);
        expect(state.dictation.kind).toBe('listening');
        phase = 'recording';
        render();

        act(() => {
          document.dispatchEvent(shortcutEvent('keyup'));
        });
        await act(async () => {
          await Promise.resolve();
          await Promise.resolve();
        });
        expect(vi.mocked(dogfood.stop)).toHaveBeenCalledOnce();
        expect(state.dictation.kind).toBe('cancelled');
        render();
        phase = 'transcribing';
        render();
        phase = 'success';
        render();
      };

      await holdAndRelease(1);

      vi.mocked(dogfood.stop).mockClear();
      vi.mocked(dictation.cancel).mockClear();
      await holdAndRelease(2);

      vi.mocked(dogfood.stop).mockClear();
      vi.mocked(dictation.cancel).mockClear();
      await holdAndRelease(3);

      unmount();
    });

    it('new hold while prior STT is transcribing does not cancel it and still finishes', async () => {
      vi.mocked(isTauri).mockReturnValue(false);
      vi.useFakeTimers();
      let now = 0;
      const clock = () => now;
      let runSeq = 0;
      let phase: DogfoodPhase = 'transcribing';
      const dictation = makeDictation();
      const dogfood = makeDogfood();
      const state: AppState = {
        ...createInitialState(0),
        dictation: { kind: 'cancelled', runId: 1 },
      };
      runSeq = 1;
      vi.mocked(dictation.start).mockImplementation(() => {
        runSeq += 1;
        state.dictation = {
          kind: 'listening',
          runId: runSeq,
          waveform: 'silent',
        };
      });
      vi.mocked(dictation.cancel).mockImplementation((runId) => {
        const d = state.dictation;
        if (d.kind === 'listening' && d.runId === runId) {
          state.dictation = { kind: 'cancelled', runId };
        }
      });
      const props = () => makeOptions({
        dictation,
        dogfood: { ...dogfood, phase },
        now: clock,
        state: { ...state },
      });
      const { rerender, unmount } = renderHook(
        (p) => useShortcutGestures(p),
        { initialProps: props() },
      );
      const render = () => rerender(props());

      act(() => {
        document.dispatchEvent(shortcutEvent('keydown'));
      });
      now += 320;
      act(() => {
        vi.advanceTimersByTime(320);
      });
      // Prior utterance's STT/delivery keeps running in the background.
      expect(dogfood.cancel).not.toHaveBeenCalled();
      expect(vi.mocked(dogfood.start)).toHaveBeenCalledOnce();
      expect(state.dictation.kind).toBe('listening');
      render();
      phase = 'recording';
      render();

      act(() => {
        document.dispatchEvent(shortcutEvent('keyup'));
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(vi.mocked(dogfood.stop)).toHaveBeenCalledOnce();
      expect(state.dictation.kind).toBe('cancelled');

      unmount();
    });
  });

});

describe('HUD result states (UI PR 8)', () => {
  async function finish(over: Partial<ReturnType<typeof makeDogfood>>) {
    vi.mocked(isTauri).mockReturnValue(true);
    mocks.createNativeShortcutController.mockReturnValue(makeNativeController());
    const overlay = makeOverlay();
    mocks.createOverlayBridge.mockReturnValue(overlay);
    const dogfood = makeDogfood({ phase: 'transcribing' });
    const { rerender, unmount } = renderHook((props) => useShortcutGestures(props), {
      initialProps: makeOptions({ dogfood }),
    });
    rerender(makeOptions({ dogfood: { ...dogfood, ...over } }));
    await act(async () => { await Promise.resolve(); });
    unmount();
    return overlay;
  }

  it('flashes Copied for a gesture run', async () => {
    const overlay = await finish({ hudResult: 'copied', origin: 'gesture', phase: 'success' });
    expect(overlay.showResult).toHaveBeenCalledWith('copied');
  });

  it('flashes Couldn’t transcribe on a gesture error', async () => {
    const overlay = await finish({ hudResult: 'transcribe-failed', origin: 'gesture', phase: 'error' });
    expect(overlay.showResult).toHaveBeenCalledWith('transcribe-failed');
  });

  it('shows nothing for an insert (silent dismiss), a Home run, or a cancel', async () => {
    for (const over of [
      { hudResult: null, origin: 'gesture' as const, phase: 'success' as const },
      { hudResult: 'copied' as const, origin: 'home' as const, phase: 'success' as const },
      { hudResult: 'copied' as const, origin: 'gesture' as const, phase: 'cancelled' as const },
    ]) {
      const overlay = await finish(over);
      expect(overlay.showResult).not.toHaveBeenCalled();
      expect(overlay.sync).toHaveBeenCalledWith({ kind: 'ready' });
    }
  });
});
