import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Settings } from "../../src/features/settings/Settings";
import { renderWithApp } from "./testUtils";

describe("Settings", () => {
  it("updates controls and labels simulated capabilities", async () => {
    const user = userEvent.setup();
    const setup = vi.fn();
    renderWithApp(<Settings onSetup={setup} />);
    await user.selectOptions(screen.getByLabelText("Current style"), "casual");
    expect(screen.getByLabelText("Current style")).toHaveValue("casual");
    await user.click(screen.getByLabelText("Sodium Rain"));
    expect(screen.getByLabelText("Sodium Rain")).toBeChecked();
    await user.click(screen.getByRole("button", {
      name: "Set up shortcuts",
    }));
    expect(setup).toHaveBeenCalledOnce();
    expect(screen.getAllByText(/simulated/i).length).toBeGreaterThan(2);
    expect(screen.getByText(/resets on reload/i)).toBeInTheDocument();
  });
});
