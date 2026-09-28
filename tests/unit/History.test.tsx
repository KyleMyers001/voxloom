import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { History } from "../../src/features/history/History";
import { isTauriEnv } from "../../src/services/capture/captureService";
import { renderWithApp } from "./testUtils";

describe("History", () => {
  it("filters records and offers Retry only before expiry", async () => {
    vi.useFakeTimers();
    let now = 1_800_000_000_000;
    renderWithApp(<History onToast={vi.fn()} />, () => now);
    expect(screen.getByRole("button", {
      name: "Retry transcription",
    })).toBeInTheDocument();
    expect(screen.getByText(/Temporary recovery buffer · expires/))
      .toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("History status"), {
      target: { value: "failed" },
    });
    expect(screen.getAllByRole("article")).toHaveLength(1);
    now += 11 * 60_000;
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.queryByRole("button", {
      name: "Retry transcription",
    })).not.toBeInTheDocument();
    expect(screen.getByText("Temporary recovery buffer expired"))
      .toBeInTheDocument();
    vi.useRealTimers();
  });

  it("offers native failed text for Copy without promising an audio retry", async () => {
    vi.mocked(isTauriEnv).mockReturnValue(true);
    try {
      const toast = vi.fn();
      renderWithApp(<History onToast={toast} />);
      expect(screen.queryByRole("button", { name: "Retry transcription" }))
        .not.toBeInTheDocument();
      expect(screen.queryByText(/Temporary recovery buffer/))
        .not.toBeInTheDocument();
      fireEvent.change(screen.getByLabelText("History status"), {
        target: { value: "failed" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Copy transcript" }));
      await waitFor(() => expect(toast).toHaveBeenCalledWith("Copied to clipboard"));
    } finally {
      vi.mocked(isTauriEnv).mockReturnValue(false);
    }
  });

  it("reports expiry when time changes immediately before Retry", async () => {
    const toast = vi.fn();
    let now = 1_800_000_000_000;
    renderWithApp(<History onToast={toast} />, () => now);
    const retry = screen.getByRole("button", {
      name: "Retry transcription",
    });
    now += 11 * 60_000;
    fireEvent.click(retry);
    expect(toast).toHaveBeenCalledWith("Recovery buffer expired");
  });
});
