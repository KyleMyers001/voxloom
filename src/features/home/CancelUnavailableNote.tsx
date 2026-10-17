import { useState } from 'react';
import { Icon } from '../../components/Icon';
import {
  cancelSettingsPane,
  cancelUnavailableHint,
  type CancelUnavailable,
} from '../../services/shortcut/cancelUnavailable';
import { openPrivacyPane, PRIVACY_PANE_LABEL } from '../../services/shortcut/privacyPane';

type Props = {
  notice: CancelUnavailable;
  onCopy: (text: string) => void;
};

/** Home note when Escape-cancel could not arm: hint, Settings link, details. */
export function CancelUnavailableNote({ notice, onCopy }: Props) {
  const [openFailed, setOpenFailed] = useState(false);
  const pane = cancelSettingsPane(notice.code);

  const openSettings = () => {
    if (!pane) return;
    setOpenFailed(false);
    openPrivacyPane(pane).catch((error: unknown) => {
      console.warn('Could not open System Settings.', error);
      setOpenFailed(true);
    });
  };

  return (
    <div className="note" data-code={notice.code}>
      <p><Icon name="info" size={14} /> {cancelUnavailableHint(notice.code)}</p>
      <div className="action-group">
        {pane && (
          <button className="btn" onClick={openSettings} type="button">
            <Icon name="gear" /> Open System Settings
          </button>
        )}
        <button className="btn" onClick={() => onCopy(notice.details)} type="button">
          <Icon name="copy" /> Copy error details
        </button>
      </div>
      {pane && openFailed && (
        <p className="form-error" role="status">
          Couldn&apos;t open System Settings. Open it, go to Privacy &amp; Security, then {PRIVACY_PANE_LABEL[pane]}, and allow Voxloom.
        </p>
      )}
    </div>
  );
}
