import { act, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "../../src/app/App";
import { renderWithApp } from "./testUtils";

const shortcut = {
  code: "Space",
  ctrlKey: true,
  key: " ",
  shiftKey: true,
};

async function reachPractice(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", {
    name: "Enable mock microphone",
  }));
  await user.click(screen.getByRole("button", { name: "Next" }));
  await user.click(screen.getByRole("button", { name: "Next" }));
}

function tap() {
  fireEvent.keyDown(document, shortcut);
  fireEvent.keyUp(document, shortcut);
}

describe("practice interaction transitions", () => {
  it("resets a partial tap between practice and product", async () => {
    let now = 0;
    const user = userEvent.setup();
    renderWithApp(<App />, () => now);
    await reachPractice(user);
    tap();
    await user.click(screen.getByRole("button", { name: "Skip" }));

    vi.useFakeTimers();
    now = 100;
    tap();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(260));
    now = 400;
    fireEvent.keyDown(document, shortcut);
    act(() => vi.advanceTimersByTime(319));
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("img", { name: "silent mock waveform" }))
      .toBeInTheDocument();
    fireEvent.keyUp(document, shortcut);
    act(() => vi.advanceTimersByTime(500));
    vi.useRealTimers();
  });

  it("does not carry a latched practice gesture into product", async () => {
    let now = 0;
    const user = userEvent.setup();
    renderWithApp(<App />, () => now);
    await reachPractice(user);
    tap();
    now = 100;
    tap();
    expect(screen.getByText(/Double-tap latched/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Skip" }));

    vi.useFakeTimers();
    now = 150;
    tap();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    now = 200;
    tap();
    expect(screen.getByRole("img", { name: "silent mock waveform" }))
      .toBeInTheDocument();
    now = 250;
    tap();
    expect(screen.queryByRole("img", { name: "silent mock waveform" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "speaking mock waveform" }))
      .toBeInTheDocument();
    act(() => vi.advanceTimersByTime(500));
    vi.useRealTimers();
  });
});
