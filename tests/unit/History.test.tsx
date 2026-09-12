import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { History } from "../../src/features/history/History";
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
