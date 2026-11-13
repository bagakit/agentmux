/**
 * The code AgentMux runs inside a page, in its own isolated world, to take native input on a target.
 *
 * These are function declarations sent with Runtime.callFunctionOn: they focus a field, place its
 * caret, set a picker's value, read the value back and give focus back to where the person had it.
 * They decide nothing about the program or the run; browser-page-dispatch.ts sends them and turns
 * their answers into page-call results. Kept apart so the page side of input can be read, reviewed
 * and changed as one piece, and the shared focus rule cannot drift between three copies.
 */
/**
 * 动作做完把页面内的光标还给人（T-012 「不抢焦点」）。
 *
 * `fillInput` / `typeText` / `pressKey` 都得先 `focus()` 才能让页面按真实输入那样反应，而那一下
 * 抢的是**页面里的光标**：人正在一个输入框里打字，Agent 去填另一个框，人的字就打到别处去了。
 * 三处都要还——只还一处等于另外两处照抢（MEMORY「守卫按出口数不按条件数」）。
 *
 * 写成一段共享的源码片段插进三个 declaration，而不是三份手抄：手抄的三份会各自漂移，而漂移的
 * 那一份不会报错，只是悄悄不还了。
 *
 * 只在**焦点确实还在我们动过的那个元素上**时才还回去：动作可能让页面自己把焦点挪走
 * （提交表单、弹出对话框），那时硬抢回来就是我们在跟页面打架。
 *
 * 注意这里还不了窗口级的焦点——驱动路从不调 `webContents.focus()` / `setVisible`，所以窗口级
 * 抢焦点根本不存在。参考项目那套 `inert` + `opacity-0` 是给渲染进程里的 `<webview>` 宿主元素
 * 写的，AgentMux 用的是窗口级 `WebContentsView`，**不能照搬**（不是漏抄）。
 */
const RESTORE_FOCUS_SNIPPET = `
  // The deepest focused element reachable through open shadow roots: who had focus before we acted.
  const focusedElement = () => {
    let focused = document.activeElement
    while (focused && focused.shadowRoot && focused.shadowRoot.activeElement) focused = focused.shadowRoot.activeElement
    return focused
  }
  // Whether an element holds focus, judged from its own side so it works in open and closed shadow
  // roots and for a host that delegates focus: at each level up to the document, that level's root
  // must have this node (or, in light DOM, something inside it) as its active element.
  const holdsFocus = (element) => {
    let node = element
    while (node) {
      const root = node.getRootNode()
      const active = root.activeElement
      if (!active || (active !== node && !node.contains(active))) return false
      if (root === document) return true
      node = root.host
    }
    return false
  }
  const focusable = (element) => element instanceof HTMLElement || element instanceof SVGElement
  // After the action: give focus back only while it is still on what we acted on, so a page that moved
  // focus itself (a submitted form, an opened dialog) is not fought.
  const restoreFocus = (acted, previous) => {
    if (previous === acted) return
    if (!holdsFocus(acted)) return
    if (focusable(previous)) previous.focus()
    else if (acted instanceof HTMLElement) acted.blur()
  }
  // After a refusal: focus() may already have moved focus (a page handler can bounce it elsewhere),
  // so put it back where the person had it.
  const returnFocus = (previous) => { if (focusable(previous) && !holdsFocus(previous)) previous.focus() }
  const FOCUS_REFUSED = 'did not keep focus: it cannot take focus, is inert (behind a modal dialog) or hidden, or the page moved focus elsewhere'`

/**
 * Scroll before reading geometry. `instant`, because a page with `scroll-behavior: smooth` would still
 * be moving the box when its quad is read, and the press would land where the element used to be.
 */
export const SCROLL_INTO_VIEW = 'function () { this.scrollIntoView({block: "center", inline: "center", behavior: "instant"}) }'

/** Isolated world for the geometry checks, so page scripts cannot patch `contains`, `labels` or `matches`. */
export const BROWSER_NATIVE_INPUT_WORLD = 'agentmux-native-input'

/**
 * Is the topmost node at the click point this target? It counts when it is the target, inside it
 * (crossing shadow roots) or inside one of its labels: a label click activates its control, which is
 * how a styled checkbox hidden behind its label is normally clicked.
 */
export const OWNS_HIT_DECLARATION = `function (hit) {
  const self = this instanceof Element ? this : this.parentElement;
  if (!(self instanceof Element)) return false;
  const owners = [self, ...(self.labels ? Array.from(self.labels) : [])];
  for (let node = hit; node; node = node.parentNode || node.host) if (owners.includes(node)) return true;
  return false;
}`

/**
 * A one-move witness in the original isolated world. CSS :hover is presentation state and
 * can stay empty after navigation even when trusted mousemove reached the exact target.
 * The remote handle owns its listener; Main reads and disposes it after its native move.
 */
export const PREPARE_POINTER_WITNESS_DECLARATION = `function () {
  const target = this, root = target.getRootNode();
  let landed = false;
  const owns = (${OWNS_HIT_DECLARATION});
  const moved = event => {
    if (!event.isTrusted || event.buttons !== 0) return;
    root.removeEventListener('mousemove', moved, true);
    const path = event.composedPath();
    landed = owns.call(target, path[0] || event.target);
  };
  root.addEventListener('mousemove', moved, true);
  return { read: () => landed, dispose: () => root.removeEventListener('mousemove', moved, true) };
}`

/**
 * Focus the target and place the caret for native text input; returns the text it held before.
 *
 * `replace` selects everything, so the inserted text replaces it. Otherwise the caret goes to the end
 * so the text is appended. Inputs without a selection API (email, number) keep their position: a
 * native End key is sent for them afterwards. A target that cannot take text is refused before
 * anything is typed.
 */
export const PREPARE_TEXT_DECLARATION = `function (replace) {${RESTORE_FOCUS_SNIPPET}
  const self = this;
  const editable = self.isContentEditable === true;
  // Pickers have no caret and drop inserted text, so they take a value instead of typing.
  if ((self instanceof HTMLInputElement && ['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range'].includes(self.type)) || self instanceof HTMLSelectElement) {
    return { ok: false, picker: true, reason: 'is a picker' };
  }
  // Checkbox, radio, file and button inputs drop inserted text too.
  if (self instanceof HTMLInputElement && !['text', 'search', 'url', 'tel', 'email', 'password', 'number'].includes(self.type)) {
    return { ok: false, reason: self.type === 'file' ? 'is a file input; use uploadFiles with the file' : 'is a ' + self.type + ' input, which takes a click, not text' };
  }
  const field = self instanceof HTMLInputElement || self instanceof HTMLTextAreaElement;
  if (!editable && !field) return { ok: false, reason: 'is not a text field or editable element' };
  // :disabled also covers a field inside a disabled fieldset, which .disabled does not.
  if (field && (self.matches(':disabled') || self.readOnly)) return { ok: false, reason: self.matches(':disabled') ? 'is disabled' : 'is read-only' };
  const previous = focusedElement();
  self.focus();
  // An inert field (behind a modal dialog) or a hidden one does not take focus.
  if (!holdsFocus(self)) { returnFocus(previous); return { ok: false, reason: FOCUS_REFUSED }; }
  const before = editable ? self.textContent ?? '' : self.value;
  let caret = 'set';
  if (editable) {
    const range = document.createRange();
    range.selectNodeContents(self);
    if (!replace) range.collapse(false);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  } else if (replace) self.select();
  else {
    try { self.setSelectionRange(self.value.length, self.value.length); } catch { caret = 'end-key'; }
  }
  globalThis.__agentMuxTextFocus = previous;
  return { ok: true, before, caret };
}`

/**
 * A picker field (date, time, month, week, color, range, select) takes a value, not typed text.
 *
 * Every refusal is decided before anything changes, because Chromium answers a value it would not keep
 * by clearing or resetting the field: a malformed date becomes empty, a range string that is not a
 * valid floating-point number becomes the midpoint, an unknown option deselects the select.
 *
 * - Disabled is `:disabled`, so a field in a disabled fieldset and an option in a disabled optgroup
 *   count. Read-only applies only to the date and time fields; HTML ignores it on range, color and
 *   select, and a person can still change those.
 * - A select takes one option, named by its value or its visible label. When the text names two
 *   different options (one by value, another by label) or several by label, it is refused with the
 *   candidates, never resolved by a guess.
 * - The field must keep focus, which an inert field (behind a modal dialog) or a hidden one does not. A
 *   field covered by another element still takes focus and its value, as it would from a person
 *   tabbing to it. Fields inside open or closed shadow roots count.
 *
 * The value then goes through the element's own setter, and input and change follow as a person's pick
 * would fire them. Returns what the setter left (`taken`, which differs from `wanted` only where the
 * field normalizes it, such as a range clamped to its maximum or seconds dropped from a time) and what
 * the field holds once the page's own handlers ran (`after`).
 */
export const SET_PICKER_VALUE_DECLARATION = `function (value) {${RESTORE_FOCUS_SNIPPET}
  const self = this;
  const quoted = JSON.stringify(value);
  if (self.matches(':disabled')) return { ok: false, reason: 'is disabled' };
  if (self.readOnly && ['date', 'time', 'datetime-local', 'month', 'week'].includes(self.type)) return { ok: false, reason: 'is read-only' };
  let next = value, index = -1;
  if (self instanceof HTMLSelectElement) {
    const options = Array.from(self.options);
    const named = options.filter((item) => item.value === value || item.label.trim() === value.trim());
    const list = (items) => items.slice(0, 8).map((item) => JSON.stringify(item.label.trim()) + ' (value ' + JSON.stringify(item.value) + ')').join(', ') + (items.length > 8 ? ' and ' + (items.length - 8) + ' more' : '');
    if (!named.length) return { ok: false, reason: 'has no option with the value or label ' + quoted + '; its options are ' + list(options) };
    if (named.length > 1) return { ok: false, reason: 'has more than one option matching ' + quoted + ': ' + list(named) + '. Give the value of the one you mean' };
    if (named[0].matches(':disabled')) return { ok: false, reason: 'has the option ' + quoted + ' turned off' };
    index = named[0].index;
    next = named[0].value;
  } else if (self.type === 'range') {
    // HTML's valid floating-point number; anything else is reset to the midpoint, not refused by Chromium.
    if (!/^-?(?:[0-9]+(?:[.][0-9]+)?|[.][0-9]+)(?:[eE][-+]?[0-9]+)?$/.test(value)) return { ok: false, reason: 'takes a number such as 7 or 2.5, not ' + quoted };
  } else if (self.type === 'color') {
    if (!/^#[0-9a-fA-F]{6}$/.test(value)) return { ok: false, reason: 'takes a color written #rrggbb, not ' + quoted };
    next = value.toLowerCase();
  } else if (value !== '') {
    // A detached input of the same type applies the same sanitizing rule without touching the page.
    const trial = document.createElement('input');
    trial.type = self.type;
    trial.value = value;
    if (trial.value === '') {
      const examples = { date: '2026-03-04', time: '14:30', 'datetime-local': '2026-03-04T14:30', month: '2026-03', week: '2026-W10' };
      return { ok: false, reason: 'does not take ' + quoted + ' as a ' + self.type + '; write it like ' + (examples[self.type] ?? 'the field shows') };
    }
  }
  const previous = focusedElement();
  self.focus();
  if (!holdsFocus(self)) { returnFocus(previous); return { ok: false, reason: FOCUS_REFUSED }; }
  const before = self.value;
  if (index >= 0) Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex').set.call(self, index);
  else Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(self, next);
  const taken = self.value;
  if (taken !== before) {
    self.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    self.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const after = self.value;
  // The page's focus goes back where the person had it, as after typing.
  restoreFocus(self, previous);
  return { ok: true, before, taken, after, wanted: next };
}`

/** The value after native text input, read in the same isolated world; page code cannot answer for it. */
export const READ_TEXT_DECLARATION = `function () {
  return this.isContentEditable ? this.textContent ?? '' : this.value;
}`

/** Return page focus to where it was before native text input, as the synthetic path did (T-012). */
export const RESTORE_TEXT_FOCUS_DECLARATION = `function () {${RESTORE_FOCUS_SNIPPET}
  const previous = globalThis.__agentMuxTextFocus;
  delete globalThis.__agentMuxTextFocus;
  restoreFocus(this, previous);
}`

/**
 * Named keys with their DOM `code` and Windows virtual key code. Chromium needs all three to run a
 * key's default action (Enter submits, Tab moves focus, Space activates a button). One printable
 * character carries `text` so it types as it does for a person. Any other string is sent as the
 * key name alone: it is never parsed into a chord and never types text, as before.
 */
const NAMED_KEYS: Readonly<Record<string, { code: string; keyCode: number; text?: string }>> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' }, Tab: { code: 'Tab', keyCode: 9 }, Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 }, Delete: { code: 'Delete', keyCode: 46 }, ' ': { code: 'Space', keyCode: 32, text: ' ' },
  Space: { code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 }, ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 }, ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 }, End: { code: 'End', keyCode: 35 }, PageUp: { code: 'PageUp', keyCode: 33 }, PageDown: { code: 'PageDown', keyCode: 34 }
}

/** CDP's modifier bits, and each modifier key's own native fields so it is pressed and released like a person's. */
const MODIFIERS: Readonly<Record<string, { bit: number; key: string; code: string; keyCode: number }>> = {
  Alt: { bit: 1, key: 'Alt', code: 'AltLeft', keyCode: 18 },
  Control: { bit: 2, key: 'Control', code: 'ControlLeft', keyCode: 17 },
  Meta: { bit: 4, key: 'Meta', code: 'MetaLeft', keyCode: 91 },
  Shift: { bit: 8, key: 'Shift', code: 'ShiftLeft', keyCode: 16 }
}
const MODIFIER_ALIASES: Readonly<Record<string, string>> = { Ctrl: 'Control', Cmd: 'Meta', Command: 'Meta', Option: 'Alt' }

/**
 * One `pressKey` chord: modifiers in the order written, then the key, as `Control+a` or `Shift+Tab`.
 * A lone `+` and a trailing `++` mean the plus key. Unknown modifier names are refused, so a typo is
 * never sent as some other key.
 */
export function parseKeyChord(chord: string): { modifiers: { bit: number; key: string; code: string; keyCode: number }[]; key: string } {
  const parts = chord === '+' ? ['+'] : chord.endsWith('++') ? [...chord.slice(0, -2).split('+'), '+'] : chord.split('+')
  const key = parts.pop() ?? ''
  if (!key) throw new TypeError(`pressKey needs a key after the modifiers in ${JSON.stringify(chord)}, as Control+a or Shift+Tab.`)
  const modifiers = parts.map(name => {
    const modifier = MODIFIERS[MODIFIER_ALIASES[name] ?? name]
    if (!modifier) throw new TypeError(`${JSON.stringify(name)} is not a modifier in ${JSON.stringify(chord)}. Use Alt, Control, Meta or Shift.`)
    return modifier
  })
  if (new Set(modifiers.map(modifier => modifier.bit)).size !== modifiers.length) throw new TypeError(`${JSON.stringify(chord)} names a modifier twice.`)
  return { modifiers, key }
}

/**
 * macOS binds its editing shortcuts in the browser, not in the page, so a native key alone does not
 * select all or undo there; Chromium needs the editing command sent with the key (as Playwright does).
 * Keyed by modifier bits and key code.
 */
const MAC_EDITING_COMMANDS: Readonly<Record<string, string>> = {
  '4:KeyA': 'selectAll', '4:KeyC': 'copy', '4:KeyX': 'cut', '4:KeyV': 'paste', '4:KeyZ': 'undo', '12:KeyZ': 'redo'
}

/** The editing command a chord carries on this platform, if any. */
export function editingCommandFor(modifierBits: number, code: string, platform: string = process.platform): string | undefined {
  return platform === 'darwin' ? MAC_EDITING_COMMANDS[`${modifierBits}:${code}`] : undefined
}

/** The native key event fields for one `pressKey` key. */
export function nativeKeyFor(key: string): { key: string; code: string; keyCode: number; text?: string } {
  const named = Object.hasOwn(NAMED_KEYS, key) ? NAMED_KEYS[key]! : undefined
  if (named) return { key: key === 'Space' ? ' ' : key, ...named }
  if ([...key].length !== 1 || /[\p{Cc}\p{Cf}]/u.test(key)) return { key, code: '', keyCode: 0 }
  const upper = key.toUpperCase()
  if (/^[A-Z]$/.test(upper)) return { key, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: key }
  if (/^[0-9]$/.test(key)) return { key, code: `Digit${key}`, keyCode: key.charCodeAt(0), text: key }
  // Other characters have no layout-independent code; they still type their text.
  return { key, code: '', keyCode: 0, text: key }
}

/** Focus the target for a native key press and remember who had focus; refused when it cannot take focus. */
export const FOCUS_FOR_KEY_DECLARATION = `function () {${RESTORE_FOCUS_SNIPPET}
  const self = this;
  const previous = focusedElement();
  self.focus();
  if (!holdsFocus(self)) { returnFocus(previous); return { ok: false, reason: FOCUS_REFUSED }; }
  globalThis.__agentMuxTextFocus = previous;
  return { ok: true };
}`
