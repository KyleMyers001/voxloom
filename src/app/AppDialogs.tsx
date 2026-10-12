import { Dialog } from '../components/Dialog';
import { KeyCombo } from '../components/KeyCombo';

type ShortcutsProps = { shortcut: string; opener: HTMLElement | null; onClose: () => void };

export function ShortcutsDialog({ shortcut, opener, onClose }: ShortcutsProps) {
  return (
    <Dialog label="Keyboard shortcuts" onClose={onClose} opener={opener}>
      <h2>Keyboard shortcuts</h2>
      <p>Hold or double-tap the shortcut in any app (global in the desktop app; only while focused in the browser preview).</p>
      <div className="kv"><span>Dictate (hold / double-tap to latch)</span><KeyCombo combo={shortcut} /></div>
      <div className="kv">
        <span>Go to Home · History · Dictionary</span>
        <span><KeyCombo combo="Alt+1" /> … <KeyCombo combo="Alt+3" /></span>
      </div>
      <div className="kv"><span>Settings</span><span><KeyCombo combo="CommandOrControl+," /> or <KeyCombo combo="Alt+4" /></span></div>
      <div className="kv"><span>Show this sheet</span><KeyCombo combo="?" /></div>
      <div className="sheet-acts">
        <button className="btn primary" onClick={onClose} type="button">Done</button>
      </div>
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
