import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Home } from "../../src/features/home/Home";
import { renderWithApp } from "./testUtils";

describe("Home", () => {
  it("limits recent rows and reports copy success", async () => {
    const user = userEvent.setup();
    const toast = vi.fn();
    renderWithApp(<Home onToast={toast} />);
    expect(screen.getAllByRole("button", { name: "Copy dictation" }))
      .toHaveLength(5);
    expect(screen.getAllByText(/AM|PM/)).toHaveLength(5);
    await user.click(screen.getAllByRole("button", {
      name: "Copy dictation",
    })[0]);
    expect(toast).toHaveBeenCalledWith("Copied to clipboard");
  });

  it("reports injected clipboard failure", async () => {
    const user = userEvent.setup();
    const toast = vi.fn();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    renderWithApp(<Home onToast={toast} />);
    await user.click(screen.getAllByRole("button", {
      name: "Copy dictation",
    })[0]);
    expect(toast).toHaveBeenCalledWith("Copy failed");
  });

  it("shows the Dictate capture panel on Home", () => {
    renderWithApp(<Home onToast={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Dictate" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start capture" })).toBeDisabled();
    expect(screen.getByText(/Native capture requires the Tauri shell/i))
      .toBeInTheDocument();
  });
});
