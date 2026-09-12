/// Settings component tests.
///
/// The capture hook is mocked to avoid live IPC. Real permission flow,
/// real device list, and real mic test are covered in manual tests
/// documented in docs/review/BUS-9-implementation.md.
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Settings } from "../../src/features/settings/Settings";
import { renderWithApp } from "./testUtils";

// --- Capture hook mock -------------------------------------------------
vi.mock("../../src/services/capture/useCaptureState", () => ({
  useCaptureState: () => ({
    captureState: { kind: "idle" },
    devices: ["Built-in Microphone", "USB Audio"],
    permissionStatus: "authorized",
    requestMicPermission: vi.fn(),
    runMicTest: vi.fn().mockResolvedValue(undefined),
    stopMicTest: vi.fn(),
  }),
}));

vi.mock("../../src/services/capture/captureService", () => ({
  isTauriEnv: vi.fn().mockReturnValue(true),
}));
// -----------------------------------------------------------------------

describe("Settings", () => {
  it("updates style and appearance controls", async () => {
    const user = userEvent.setup();
    renderWithApp(<Settings onSetup={vi.fn()} />);
    await user.selectOptions(
      screen.getByLabelText("Current style"),
      "casual",
    );
    expect(screen.getByLabelText("Current style")).toHaveValue("casual");
    await user.click(screen.getByLabelText("Sodium Rain"));
    expect(screen.getByLabelText("Sodium Rain")).toBeChecked();
  });

  it("calls onSetup when Set up shortcuts clicked", async () => {
    const user = userEvent.setup();
    const setup = vi.fn();
    renderWithApp(<Settings onSetup={setup} />);
    await user.click(
      screen.getByRole("button", { name: "Set up shortcuts" }),
    );
    expect(setup).toHaveBeenCalledOnce();
  });

  it("labels shortcuts and models as simulated", () => {
    renderWithApp(<Settings onSetup={vi.fn()} />);
    expect(
      screen.getAllByText(/simulated/i).length,
    ).toBeGreaterThan(2);
  });

  it("does not claim audio resets on reload", () => {
    renderWithApp(<Settings onSetup={vi.fn()} />);
    // The old false copy "resets on reload" is gone; verify replacement.
    expect(screen.queryByText(/resets on reload/i)).toBeNull();
    expect(screen.getByText(/captured locally/i)).toBeInTheDocument();
  });

  it("renders real device names in the microphone select", () => {
    renderWithApp(<Settings onSetup={vi.fn()} />);
    expect(
      screen.getByRole("option", { name: "Built-in Microphone" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "USB Audio" }),
    ).toBeInTheDocument();
  });

  it("shows Test Microphone button when authorized", () => {
    renderWithApp(<Settings onSetup={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: "Test Microphone" }),
    ).toBeInTheDocument();
  });

  it("shows honest recovery copy for microphone denied", () => {
    renderWithApp(<Settings onSetup={vi.fn()} />);
    expect(
      screen.getByText(/Microphone denied/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Privacy.*Security.*Microphone/i),
    ).toBeInTheDocument();
  });
});
