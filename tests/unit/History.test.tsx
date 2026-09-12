import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { History } from "../../src/features/history/History";
import { renderWithApp } from "./testUtils";

describe("History", () => {
  it("filters records and offers Retry only before expiry", async () => {
    const user = userEvent.setup();
    let now = 1_800_000_000_000;
    renderWithApp(<History onToast={vi.fn()} />, () => now);
    expect(screen.getByRole("button", {
      name: "Retry transcription",
    })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("History status"), "failed");
    expect(screen.getAllByRole("article")).toHaveLength(1);
    await user.type(screen.getByRole("searchbox"), "missing phrase");
    expect(screen.getByText("No history matches these filters."))
      .toBeInTheDocument();
    now += 11 * 60_000;
    await user.clear(screen.getByRole("searchbox"));
    expect(screen.queryByRole("button", {
      name: "Retry transcription",
    })).not.toBeInTheDocument();
  });
});
