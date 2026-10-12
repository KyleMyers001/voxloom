import { useEffect, useRef } from 'react';
import { useApp } from '../../app/AppContext';
import { isTauriEnv } from '../../services/capture/captureService';
import { SYSTEM_DEFAULT_DEVICE_ID } from '../../services/capture/types';
import { useCaptureState } from '../../services/capture/useCaptureState';

/** Microphone select + Refresh (S3/S4) and Microphone test (S5). Logic unchanged from the old Settings. */
export function MicrophoneRows() {
  const { settings, state } = useApp();
  const selectedLabelRef = useRef<{ id: string; label: string } | null>(null);
  const {
    captureReady, captureState, deviceListError, devices, devicesLoading, permissionStatus,
    prepareDeviceChange, refreshDevices, requestMicPermission, runMicTest, stopMicTest,
  } = useCaptureState();

  const isNative = isTauriEnv();
  const micAuthorized = permissionStatus === 'authorized';
  const micTesting = captureState.kind === 'test-running';
  const micSwitching = captureState.kind === 'switching-device';
  const micError = captureState.kind === 'error' ? captureState.message : null;
  const selectedDevice = state.settings.microphone;
  const selectedDescriptor = devices.find((device) => device.id === selectedDevice);
  useEffect(() => {
    if (selectedDescriptor) {
      selectedLabelRef.current = { id: selectedDescriptor.id, label: selectedDescriptor.label };
    }
  }, [selectedDescriptor]);
  const missingDeviceLabel = selectedLabelRef.current?.id === selectedDevice
    ? selectedLabelRef.current.label
    : 'Previously selected microphone';
  const selectionUnavailable = selectedDevice !== SYSTEM_DEFAULT_DEVICE_ID
    && (!selectedDescriptor || !selectedDescriptor.available);

  async function handleDeviceChange(deviceId: string) {
    if (deviceId === selectedDevice) return;
    if (await prepareDeviceChange()) settings.update({ key: 'microphone', value: deviceId });
  }

  function handleTestMic() {
    if (micTesting) stopMicTest();
    else void runMicTest(selectedDevice !== SYSTEM_DEFAULT_DEVICE_ID ? selectedDevice : undefined);
  }

  const testStatus = !isNative ? 'Native microphone capture is unavailable here'
    : !micAuthorized
      ? permissionStatus === 'denied' ? 'Permission denied — enable in System Settings' : 'Permission required'
      : micSwitching ? 'Waiting for microphone to stop…'
        : selectionUnavailable ? 'Selected microphone is unavailable'
          : captureState.kind === 'test-complete'
            ? captureState.metadata.detected_activity ? 'Audio activity detected' : 'No audio activity detected'
            : micTesting ? 'Listening\u2026 (10 s auto-stop)' : 'Ready';

  return (
    <>
      <div className="frow">
        <span className="frow__label"><label htmlFor="settings-microphone">Microphone</label></span>
        <span className="frow__control">
          <select
            disabled={!isNative || !captureReady || micSwitching}
            id="settings-microphone"
            onChange={(event) => { void handleDeviceChange(event.target.value); }}
            onFocus={() => { void refreshDevices(); }}
            value={state.settings.microphone}
          >
            <option value={SYSTEM_DEFAULT_DEVICE_ID}>System default</option>
            {selectionUnavailable && !selectedDescriptor && (
              <option disabled value={selectedDevice}>{missingDeviceLabel} (unavailable)</option>
            )}
            {devices.map((device) => (
              <option disabled={!device.available} key={device.id} value={device.id}>
                {device.label}{device.available ? '' : ' (unavailable)'}
              </option>
            ))}
          </select>
          <button
            className="btn"
            disabled={!isNative || !captureReady || devicesLoading || micSwitching}
            onClick={() => { void refreshDevices(); }}
            type="button"
          >
            {devicesLoading ? 'Refreshing…' : 'Refresh microphones'}
          </button>
        </span>
      </div>
      {deviceListError && <div className="banner banner--error" role="alert">{deviceListError}</div>}
      <div className="frow">
        <span className="frow__label">
          <span>Microphone test</span>
          <small className="frow__help">Stops automatically after 10 seconds.</small>
        </span>
        <span className="frow__control">
          <span className="fine" role="status">{testStatus}</span>
          {!isNative ? (
            <button className="btn" disabled type="button">Unavailable</button>
          ) : !micAuthorized ? (
            <button className="btn" onClick={requestMicPermission} type="button">Enable Microphone</button>
          ) : (
            <button
              className="btn"
              disabled={!captureReady || micSwitching || selectionUnavailable}
              onClick={handleTestMic}
              type="button"
            >
              {micTesting ? 'Stop test' : 'Test Microphone'}
            </button>
          )}
        </span>
      </div>
      {micError && <p className="form-error" role="alert">{micError}</p>}
    </>
  );
}
