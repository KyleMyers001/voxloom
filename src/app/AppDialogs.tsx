import { Dialog } from '../components/Dialog';
import { KeyCombo } from '../components/KeyCombo';

type ShortcutsProps = { shortcut: string; opener: HTMLElement | null; onClose: () => void };

export function ShortcutsDialog({ shortcut, opener, onClose }: ShortcutsProps) {
  return (
    <Dialog label="Keyboard shortcuts" onClose={onClose} opener={opener}>
      <h2>Keyboard shortcuts</h2>
      <p>Hold or double-tap the configured shortcut (global in the desktop shell; app-focused in browser preview). Hold while Notes is focused to smoke Inserted; Home Start may Copy if Voxloom is focused.</p>
      <div className="overlay__row"><span>Configured gesture</span>
        <KeyCombo combo={shortcut} /></div>
      <div className="overlay__row"><span>Navigate screens</span>
        <kbd>Alt + 1…3</kbd></div>
      <div className="overlay__row"><span>Settings</span>
        <kbd>⌘, or Alt + 4</kbd></div>
      <div className="overlay__row"><span>This sheet</span><kbd>?</kbd></div>
    </Dialog>
  );
}

type ResetProps = { opener: HTMLElement | null; onClose: () => void; onReset: (wipe: boolean) => void };

export function ResetSessionDialog({ opener, onClose, onReset }: ResetProps) {
  return (
    <Dialog label="Reset session" onClose={onClose} opener={opener}>
      <h2>Reset session</h2>
      <p>
        Durable history is on. Choose whether to keep <code>history.json</code>
        or wipe it. Fixture seed data is never written without an explicit wipe.
      </p>
      <div className="overlay__actions">
        <button onClick={() => onReset(false)} type="button">
          Keep durable history
        </button>
        <button className="danger" onClick={() => onReset(true)} type="button">
          Wipe durable history
        </button>
        <button onClick={onClose} type="button">Cancel</button>
      </div>
    </Dialog>
  );
}
