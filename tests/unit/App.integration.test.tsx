import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../../src/app/App";
import { renderWithApp } from "./testUtils";

describe("App integration", () => {
  it("gates first run, completes dictation, and shares mutations", async () => {
    const user = userEvent.setup();
    renderWithApp(<App />);
    expect(screen.getByRole("dialog", {
      name: "Set up Voxloom",
    })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Skip" }));
    await user.click(screen.getByRole("button", {
      name: "Start mock dictation",
    }));
    expect(screen.getByRole("img")).toBeInTheDocument();
    await user.click(screen.getByRole("button", {
      name: "Finish mock dictation",
    }));
    await user.click(screen.getByRole("button", {
      name: "Complete mock result",
    }));
    expect(screen.getByText(
      "Keep the TypeScript boundary small and explicit.",
    )).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.selectOptions(screen.getByLabelText("Current style"), "casual");
    await user.keyboard("{Alt>}1{/Alt}");
    expect(screen.getByRole("button", { name: "Casual" }))
      .toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Dictionary" }));
    await user.click(screen.getByRole("button", { name: "Add term" }));
    await user.type(screen.getByLabelText("Word"), "Vite");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("Vite")).toBeInTheDocument();
  });

  it("opens help with question mark and closes with Escape", async () => {
    const user = userEvent.setup();
    renderWithApp(<App />);
    await user.click(screen.getByRole("button", { name: "Skip" }));
    await user.keyboard("?");
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" }))
      .toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
