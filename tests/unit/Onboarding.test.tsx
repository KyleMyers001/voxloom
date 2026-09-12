/// Onboarding component tests.
///
/// The real microphone permission flow requires a live TCC context and is
/// not exercised here; the capture hook is mocked to return controlled
/// permission state. The real permission + test flows are in manual tests
/// documented in docs/review/BUS-9-implementation.md.
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Onboarding } from "../../src/features/onboarding/Onboarding";
import { renderWithApp } from "./testUtils";

// Controlled permission state and Tauri env flag for Onboarding tests.
let mockPermissionStatus = "authorized";
let mockIsTauri = true; // Tests run in native mode by default.

vi.mock("../../src/services/capture/useCaptureState", () => ({
  useCaptureState: () => ({
    captureState: { kind: "idle" },
    devices: [],
    permissionStatus: mockPermissionStatus,
    requestMicPermission: vi.fn(),
    runMicTest: vi.fn().mockResolvedValue(undefined),
    stopMicTest: vi.fn(),
  }),
}));

// Override the global isTauriEnv mock so the Onboarding shows the real
// permission UI path (not the browser-unavailable path).
vi.mock("../../src/services/capture/captureService", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../../src/services/capture/captureService")
  >();
  return {
    ...original,
    isTauriEnv: () => mockIsTauri,
  };
});

// -----------------------------------------------------------------------

describe("Onboarding (step 1 — real permission, simulated steps 2–3)", () => {
  it("allows Skip from any step without requiring permission", async () => {
    const user = userEvent.setup();
    const close = vi.fn();
    renderWithApp(<Onboarding onClose={close} />);
    await user.click(screen.getByRole("button", { name: "Skip" }));
    expect(close).toHaveBeenCalledOnce();
  });

  it("advances past step 1 when permission is authorized", async () => {
    mockPermissionStatus = "authorized";
    const user = userEvent.setup();
    renderWithApp(<Onboarding onClose={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Choose your shortcut")).toBeInTheDocument();
  });

  it("blocks Next on step 1 when permission is not-determined", async () => {
    mockPermissionStatus = "not-determined";
    const user = userEvent.setup();
    renderWithApp(<Onboarding onClose={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      /enable microphone/i,
    );
  });

  it("blocks Next on step 1 when permission is denied", async () => {
    mockPermissionStatus = "denied";
    const user = userEvent.setup();
    renderWithApp(<Onboarding onClose={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      /enable microphone/i,
    );
  });

  it("shows Enable Microphone button when not authorized", async () => {
    mockPermissionStatus = "not-determined";
    renderWithApp(<Onboarding onClose={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: "Enable Microphone" }),
    ).toBeInTheDocument();
  });

  it("does not show Enable Microphone button when authorized", async () => {
    mockPermissionStatus = "authorized";
    renderWithApp(<Onboarding onClose={vi.fn()} />);
    expect(
      screen.queryByRole("button", { name: "Enable Microphone" }),
    ).toBeNull();
  });

  it("shows Test Microphone button when authorized", async () => {
    mockPermissionStatus = "authorized";
    renderWithApp(<Onboarding onClose={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: "Test Microphone" }),
    ).toBeInTheDocument();
  });

  it("preserves Back/Next state for steps 2–3", async () => {
    mockPermissionStatus = "authorized";
    const user = userEvent.setup();
    const close = vi.fn();
    renderWithApp(<Onboarding onClose={close} />);
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Choose your shortcut")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    // Step 3: quick test
    await user.click(screen.getByRole("button", { name: "Test hold" }));
    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(
      screen.getByText(/Press-and-hold · recognized/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Finish" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      /both practice/,
    );
    await user.click(
      screen.getByRole("button", { name: "Test double-tap" }),
    );
    await user.click(screen.getByRole("button", { name: "Finish" }));
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects the simulated shortcut collision on step 2", async () => {
    mockPermissionStatus = "authorized";
    const user = userEvent.setup();
    renderWithApp(<Onboarding onClose={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Next" }));
    const shortcut = screen.getByLabelText(
      "Preferred app-local shortcut",
    );
    await user.clear(shortcut);
    await user.type(shortcut, "Ctrl + Space");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("alert")).toHaveTextContent("collision");
  });

  it("shows denied copy when permission denied on step 1", async () => {
    mockPermissionStatus = "denied";
    renderWithApp(<Onboarding onClose={vi.fn()} />);
    expect(
      screen.getByText(/Microphone access denied/i),
    ).toBeInTheDocument();
    // System Settings appears in both the status span and the note;
    // verify at least one instance is present.
    expect(
      screen.getAllByText(/System Settings/i).length,
    ).toBeGreaterThanOrEqual(1);
  });
});
