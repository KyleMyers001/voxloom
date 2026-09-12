import { act, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "../../src/app/App";
import { renderWithApp } from "./testUtils";

describe("App integration", () => {
  it("drives onboarding practices from configured gestures", async () => {
    let now = 0;
    const user = userEvent.setup();
    renderWithApp(<App />, () => now);
    await user.click(screen.getByRole("button", {
      name: "Enable mock microphone",
    }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    vi.useFakeTimers();
    const key = {
      code: "Space",
      ctrlKey: true,
      key: " ",
      shiftKey: true,
    };
    fireEvent.keyDown(document, key);
    now = 320;
    act(() => vi.advanceTimersByTime(320));
    fireEvent.keyUp(document, key);
    expect(screen.getByText(/Press-and-hold · recognized/))
      .toBeInTheDocument();
    now = 400;
    fireEvent.keyDown(document, key);
    fireEvent.keyUp(document, key);
    now = 500;
    fireEvent.keyDown(document, key);
    fireEvent.keyUp(document, key);
    now = 600;
    fireEvent.keyDown(document, key);
    fireEvent.keyUp(document, key);
    expect(screen.getByText(/Rapid double-tap · recognized/))
      .toBeInTheDocument();
    vi.useRealTimers();
    await user.click(screen.getByRole("button", { name: "Finish" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("gates first run, completes dictation, and shares mutations", async () => {
    const user = userEvent.setup();
    renderWithApp(<App />);
    expect(screen.getByRole("dialog", {
      name: "Set up Voxloom",
    })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Skip" }));
    vi.useFakeTimers();
    fireEvent.keyDown(document, {
      code: "Space",
      ctrlKey: true,
      key: " ",
      shiftKey: true,
    });
    act(() => vi.advanceTimersByTime(320));
    expect(screen.getByRole("img")).toBeInTheDocument();
    fireEvent.keyUp(document, {
      code: "Space",
      ctrlKey: true,
      key: " ",
      shiftKey: true,
    });
    act(() => vi.advanceTimersByTime(500));
    vi.useRealTimers();
    expect(screen.getByText(
      "Keep the TypeScript boundary small and explicit.",
    )).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.selectOptions(screen.getByLabelText("Current style"), "casual");
    await user.keyboard("{Alt>}1{/Alt}");
    expect(screen.getByRole("button", { name: /^Casual$/ }))
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

  it("suppresses app shortcuts while a dictionary dialog is open", async () => {
    const user = userEvent.setup();
    renderWithApp(<App />);
    await user.click(screen.getByRole("button", { name: "Skip" }));
    await user.click(screen.getByRole("button", { name: "Dictionary" }));
    await user.click(screen.getByRole("button", { name: "Add term" }));
    const shortcut = {
      code: "Space",
      ctrlKey: true,
      key: " ",
      shiftKey: true,
    };
    fireEvent.keyDown(document, shortcut);
    fireEvent.keyUp(document, shortcut);
    await user.keyboard("?");
    await user.keyboard("{Alt>}1{/Alt}");
    expect(screen.getByRole("dialog", { name: "Add dictionary word" }))
      .toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dictionary" }))
      .toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    fireEvent.keyDown(document, shortcut);
    expect(screen.getByRole("img")).toBeInTheDocument();
    fireEvent.keyUp(document, shortcut);
  });

  it("reopens clean setup and reset restores first-run fixtures", async () => {
    const user = userEvent.setup();
    renderWithApp(<App />);
    await user.click(screen.getByRole("button", { name: "Skip" }));
    await user.click(screen.getByRole("button", { name: "Empty lists" }));
    expect(screen.getByText("No dictations yet.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reset session" }));
    expect(screen.getByText("Step 1 of 3")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Skip" }));
    expect(screen.getAllByRole("button", { name: "Copy dictation" }))
      .toHaveLength(5);

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", {
      name: "Set up shortcuts",
    }));
    await user.click(screen.getByRole("button", {
      name: "Enable mock microphone",
    }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Test hold" }));
    await user.click(screen.getByRole("button", { name: "Test double-tap" }));
    await user.click(screen.getByRole("button", { name: "Finish" }));
    const setup = screen.getByRole("button", { name: "Set up shortcuts" });
    await user.click(setup);
    expect(screen.getByText("Step 1 of 3")).toBeInTheDocument();
    expect(screen.getByText("Mock microphone enabled")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText(/Press-and-hold · not tested/))
      .toBeInTheDocument();
    expect(screen.getByText(/Rapid double-tap · not tested/))
      .toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(setup).toHaveFocus();
  });

  it("recovers permission denial and surfaces collision scenario", async () => {
    const user = userEvent.setup();
    renderWithApp(<App />);
    await user.click(screen.getByRole("button", { name: "Skip" }));
    await user.click(screen.getByRole("button", { name: "Permission denied" }));
    expect(screen.getByText("Mock permission denied")).toBeInTheDocument();
    await user.click(screen.getByRole("button", {
      name: "Enable mock microphone",
    }));
    expect(screen.getByText("Mock microphone enabled")).toBeInTheDocument();
    await user.click(screen.getByRole("button", {
      name: "Close Set up Voxloom",
    }));
    await user.click(screen.getByRole("button", {
      name: "Shortcut collision",
    }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("alert")).toHaveTextContent("collision");
  });
});
