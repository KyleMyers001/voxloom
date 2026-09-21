import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/services/capture/captureService", () => ({
  isTauriEnv: vi.fn().mockReturnValue(false),
}));
vi.mock("../../src/services/capture/useCaptureState", () => ({
  useCaptureState: () => ({
    captureReady: true,
    captureState: { kind: "idle" },
    deviceListError: null,
    devices: [],
    devicesLoading: false,
    permissionStatus: null,
    prepareDeviceChange: vi.fn().mockResolvedValue(true),
    refreshDevices: vi.fn().mockResolvedValue(undefined),
    requestMicPermission: vi.fn(),
    runMicTest: vi.fn(),
    stopMicTest: vi.fn(),
  }),
}));

import { Settings } from "../../src/features/settings/Settings";
import { renderWithApp } from "./testUtils";

describe("Settings without a native host", () => {
  it("shows unavailable copy and disables microphone controls", () => {
    renderWithApp(<Settings onSetup={vi.fn()} />);
    expect(screen.getByText(/native microphone capture is unavailable/i))
      .toBeInTheDocument();
    expect(screen.getByLabelText("Microphone")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Unavailable" }))
      .toBeDisabled();
    expect(screen.getByRole("button", { name: "Refresh microphones" }))
      .toBeDisabled();
    expect(screen.queryByRole("button", { name: "Enable Microphone" }))
      .not.toBeInTheDocument();
  });
});
