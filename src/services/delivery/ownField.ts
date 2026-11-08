/**
 * BUS-201: dictating into Voxloom's own text fields (e.g. Dictionary
 * "Search words"). When this window has focus and a writable text field is
 * focused, write the transcript into it through the DOM, the way typing
 * would, instead of the macOS Accessibility path aimed at other apps.
 */

// Free-text input types with a caret (email has none). Password is a secure
// field and stays excluded.
const textInputTypes = new Set(['', 'text', 'search', 'url', 'tel']);

type TextField = HTMLInputElement | HTMLTextAreaElement;

function writableTextField(element: Element | null): TextField | null {
  const field = element instanceof HTMLTextAreaElement
    || (element instanceof HTMLInputElement && textInputTypes.has(element.type))
    ? element
    : null;
  if (!field || field.readOnly || field.disabled) return null;
  return field;
}

/**
 * Insert `text` at the caret (replacing any selection) of the focused text
 * field in this window. Returns false, writing nothing, when the window
 * lacks focus or no writable text field is focused.
 */
export function insertIntoOwnField(
  text: string,
  doc: Document | undefined = globalThis.document,
): boolean {
  if (!doc?.hasFocus()) return false;
  const field = writableTextField(doc.activeElement);
  if (!field) return false;
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? start;
  field.setRangeText(text, start, end, 'end');
  // React (and any listener) sees this like typed input.
  field.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    data: text,
    inputType: 'insertText',
  }));
  return true;
}
