import { act, render, screen, waitFor } from "@testing-library/react";
import { listen } from "@tauri-apps/api/event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OverlayApp } from "../../src/overlay/OverlayApp";

type Handler = (payload: unknown) => void;
const handlers = new Map<string, Handler>();

function send(event: string, payload: unknown) {
  act(() => handlers.get(event)?.(payload));
}

function lastBarHeight(): string {
  const bars = screen.getByRole("img").querySelectorAll<HTMLElement>("i");
  return bars[23].style.getPropertyValue("--h");
}

beforeEach(() => {
  handlers.clear();
  vi.mocked(listen).mockImplementation(async (eventName, callback) => {
    handlers.set(eventName, (payload) => callback({ payload } as
      Parameters<typeof callback>[0]));
    return () => { handlers.delete(eventName); };
  });
});

describe("OverlayApp", () => {
  it("shows live session levels, ignores stale sessions and resets for a new hold",
    async () => {
      render(<OverlayApp />);
      await waitFor(() => expect(handlers.has("capture:event")).toBe(true));
      send("overlay:waveform", { waveform: "silent" });
      expect(lastBarHeight()).toBe("2px");

      send("capture:event", {
        generation: 1, kind: "capture-started", request_id: "first",
      });
      send("capture:event", {
        generation: 1, kind: "capture-level", level: 0.1,
        request_id: "first",
      });
      expect(lastBarHeight()).not.toBe("2px");

      send("capture:event", {
        generation: 0, kind: "capture-level", level: 1,
        request_id: "stale",
      });
      expect(lastBarHeight()).not.toBe("26px");

      send("overlay:waveform", { waveform: "silent" });
      expect(lastBarHeight()).toBe("2px");
      send("capture:event", {
        generation: 2, kind: "capture-level", level: 1,
        request_id: "second",
      });
      expect(lastBarHeight()).toBe("26px");
    });
});
