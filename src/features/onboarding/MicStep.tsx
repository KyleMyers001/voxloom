import { AppTile } from '../../components/AppTile';
import { Banner } from '../../components/Banner';
import { Icon } from '../../components/Icon';
import type { UseCaptureStateResult } from '../../services/capture/useCaptureState';

interface Props {
  capture: UseCaptureStateResult;
  isNative: boolean;
}

function permissionLabel(isNative: boolean, status: UseCaptureStateResult['permissionStatus']): string {
  if (!isNative) return 'Native capture unavailable in this environment';
  switch (status) {
    case 'authorized': return 'Microphone allowed';
    case 'denied': return 'Microphone access denied';
    case 'restricted': return 'Microphone access restricted by system policy';
    case 'not-determined': return 'Microphone access not yet granted';
    default: return 'Checking microphone permission…';
  }
}

/** Step 1 (mocks onboarding-1, onboarding-1-denied): hero tile, permission row, mic test. */
export function MicStep({ capture, isNative }: Props) {
  const { captureState, permissionStatus, requestMicPermission, runMicTest, stopMicTest } = capture;
  const authorized = isNative && permissionStatus === 'authorized';
  const testing = captureState.kind === 'test-running';
  const testText = captureState.kind === 'test-complete'
    ? captureState.metadata.detected_activity
      ? 'Audio activity detected. Your mic is working'
      : 'No audio activity detected. Check your mic'
    : testing ? 'Listening… (10 s auto-stop)' : 'Test your microphone';

  return (
    <section className="onboarding-step">
      <div className="ob-hero"><AppTile size="lg" /></div>
      <h3>Microphone access</h3>
      <p>Voxloom captures audio locally. No audio leaves your device.</p>
      {isNative && permissionStatus === 'denied' && (
        <Banner tone="warn">
          Permission denied. Open System Settings › Privacy &amp; Security › Microphone and enable Voxloom.
        </Banner>
      )}
      <div className="frow">
        <span>
          {authorized && <Icon name="check" size={14} />}
          {permissionLabel(isNative, permissionStatus)}
        </span>
        {isNative && !authorized && (
          <button className="btn" onClick={requestMicPermission} type="button">Enable Microphone</button>
        )}
      </div>
      {authorized && (
        <div className="frow">
          <span>{testText}</span>
          <button className="btn" onClick={() => (testing ? stopMicTest() : void runMicTest())} type="button">
            {testing ? 'Stop test' : 'Test Microphone'}
          </button>
        </div>
      )}
      {captureState.kind === 'error' && (
        <p className="form-error" role="alert">{captureState.message}</p>
      )}
    </section>
  );
}
