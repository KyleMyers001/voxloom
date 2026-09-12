import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Onboarding } from "../../src/features/onboarding/Onboarding";
import { renderWithApp } from "./testUtils";

describe("Onboarding", () => {
  it("requires both practices and preserves Back state", async () => {
    const user = userEvent.setup();
    const close = vi.fn();
    renderWithApp(<Onboarding onClose={close} />);
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("alert")).toHaveTextContent("mock microphone");
    await user.click(screen.getByRole("button", {
      name: "Enable mock microphone",
    }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Choose your shortcut")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Test hold" }));
    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText(/Press-and-hold · recognized/))
      .toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Finish" }));
    expect(screen.getByRole("alert")).toHaveTextContent("both practice");
    await user.click(screen.getByRole("button", {
      name: "Test double-tap",
    }));
    await user.click(screen.getByRole("button", { name: "Finish" }));
    expect(close).toHaveBeenCalledOnce();
  });

  it("allows Skip without requesting a permission", async () => {
    const user = userEvent.setup();
    const close = vi.fn();
    renderWithApp(<Onboarding onClose={close} />);
    await user.click(screen.getByRole("button", { name: "Skip" }));
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects the simulated shortcut collision", async () => {
    const user = userEvent.setup();
    renderWithApp(<Onboarding onClose={vi.fn()} />);
    await user.click(screen.getByRole("button", {
      name: "Enable mock microphone",
    }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    const shortcut = screen.getByLabelText("Preferred app-local shortcut");
    await user.clear(shortcut);
    await user.type(shortcut, "Ctrl + Space");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("alert")).toHaveTextContent("collision");
  });
});
