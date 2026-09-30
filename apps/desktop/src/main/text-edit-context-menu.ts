import { randomUUID } from 'node:crypto'
import { Menu, webContents, type BrowserWindow, type ContextMenuParams, type WebContents, type WebFrameMain } from 'electron'

type EditAction = 'copy' | 'cut' | 'paste' | 'selectAll'
type MenuOwner = { isCurrent(): boolean; origin?(): { x: number; y: number } }

// Only a pending menu owns this closure. It retains node/selection identity, never text or values.
// WebFrameMain has no isolated-world/edit-command API: native commands stay on the original contents.
function captureTargetScript(key: string, editable: boolean): string {
  return `(() => {
    const active = () => { let node = document.activeElement; while (node?.shadowRoot?.activeElement) node = node.shadowRoot.activeElement; return node; };
    const target = active(), selection = document.getSelection();
    if (${editable} && !(target instanceof HTMLElement && (target.matches('input,textarea') || target.isContentEditable))) return false;
    if (!${editable} && (!selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode)) return false;
    const start = selection?.anchorNode, end = selection?.focusNode, startOffset = selection?.anchorOffset, endOffset = selection?.focusOffset;
    const inputStart = target?.selectionStart, inputEnd = target?.selectionEnd;
    let changed = false;
    const onFocus = () => { if (active() !== target) changed = true; };
    document.addEventListener('focusin', onFocus, true);
    const check = () => {
      if (changed || !target?.isConnected || active() !== target) return false;
      if (${editable} && target.matches('input,textarea')) return target.selectionStart === inputStart && target.selectionEnd === inputEnd;
      const now = document.getSelection();
      return !!now && now.anchorNode === start && now.focusNode === end && now.anchorOffset === startOffset && now.focusOffset === endOffset;
    };
    Object.defineProperty(globalThis, ${JSON.stringify(key)}, { configurable: true, value: { check, dispose() { document.removeEventListener('focusin', onFocus, true); delete globalThis[${JSON.stringify(key)}]; } } });
    return check();
  })()`
}

/** Native menus dispatch to their original contents, never the application's current responder. */
export function installTextEditContextMenu(contents: WebContents, window: BrowserWindow, owner: MenuOwner): () => void {
  let disposed = false
  let pending: (() => void) | undefined
  const live = () => !disposed && !contents.isDestroyed() && !window.isDestroyed() && window.isVisible() && !window.isMinimized() && owner.isCurrent()
  const focused = () => live() && window.isFocused() && webContents.getFocusedWebContents() === contents

  const open = async (_event: Electron.Event, params: ContextMenuParams): Promise<void> => {
    pending?.()
    if (!focused() || !window.isFocused()) return
    const frame = params.frame
    if (!frame || frame.isDestroyed() || frame.detached || webContents.fromFrame(frame) !== contents) return
    const actions: Array<{ action: EditAction; label: string; enabled: boolean }> = params.isEditable
      ? [{ action: 'cut', label: 'Cut', enabled: params.editFlags.canCut },
          { action: 'copy', label: 'Copy', enabled: params.editFlags.canCopy },
          { action: 'paste', label: 'Paste', enabled: params.editFlags.canPaste },
          { action: 'selectAll', label: 'Select All', enabled: params.editFlags.canSelectAll }]
      : params.selectionText.length > 0 && params.editFlags.canCopy
        ? [{ action: 'copy', label: 'Copy', enabled: true }] : []
    if (actions.length === 0) return
    const ancestors: Array<{ frame: WebFrameMain; token: string }> = []
    for (let current: WebFrameMain | null = frame; current; current = current.parent) ancestors.push({ frame: current, token: current.frameToken })
    const key = `__agentmuxTextEdit_${randomUUID().replaceAll('-', '')}`
    let ended = false, chosen = false, menu: Menu | undefined
    const cleanup: Array<() => void> = []
    const current = () => focused() && contents.focusedFrame === frame && ancestors.every((original, index) =>
      !original.frame.isDestroyed() && !original.frame.detached && original.frame.frameToken === original.token && original.frame.parent === (ancestors[index + 1]?.frame ?? null))
    const finish = () => {
      if (ended) return
      ended = true
      for (const remove of cleanup) remove()
      if (pending === finish) pending = undefined
      if (menu) { try { menu.closePopup(window) } catch { /* Only this menu is being released. */ } }
      if (!frame.isDestroyed() && !frame.detached) void frame.executeJavaScript(`globalThis[${JSON.stringify(key)}]?.dispose()`).catch(() => {})
    }
    pending = finish
    const navigation = (event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
      if (event.isMainFrame || ancestors.some(original => original.frame === event.frame)) finish()
    }
    // The context-menu gesture already happened. Only a later press invalidates an awaiting
    // capture; its original mouseUp and ordinary motion still belong to the original gesture.
    const laterInput = (_event: Electron.Event, input: { type: string }) => {
      if (input.type === 'mouseDown' || input.type === 'keyDown' || input.type === 'rawKeyDown') finish()
    }
    contents.on('did-start-navigation', navigation)
    contents.on('input-event', laterInput)
    contents.on('before-input-event', laterInput)
    contents.on('render-process-gone', finish)
    window.on('hide', finish); window.on('minimize', finish); window.on('closed', finish)
    cleanup.push(() => contents.removeListener('did-start-navigation', navigation), () => contents.removeListener('input-event', laterInput),
      () => contents.removeListener('before-input-event', laterInput), () => contents.removeListener('render-process-gone', finish),
      () => window.removeListener('hide', finish), () => window.removeListener('minimize', finish), () => window.removeListener('closed', finish))
    const evaluate = async (script: string): Promise<boolean> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([frame.executeJavaScript(script).then(value => value === true),
          new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 750) })])
      } finally { clearTimeout(timer) }
    }
    const notice = () => {
      if (!focused() || frame.isDestroyed() || frame.detached) return
      const origin = owner.origin?.() ?? { x: 0, y: 0 }
      try {
        Menu.buildFromTemplate([{ label: 'Text target changed or unavailable. Open its menu again.', enabled: false }]).popup({
          window, frame, x: Math.round(origin.x + params.x), y: Math.round(origin.y + params.y) })
      } catch { console.warn('Text editing menu is unavailable; the original input and native keyboard editing remain available.') }
    }
    try {
      const captured = await evaluate(captureTargetScript(key, params.isEditable))
      if (ended) return
      if (!captured || !current()) { finish(); notice(); return }
      menu = Menu.buildFromTemplate(actions.map(item => ({ label: item.label, enabled: item.enabled, click: () => {
        if (chosen || ended || !item.enabled) return
        chosen = true
        void (async () => {
          try {
            const sameTarget = await evaluate(`globalThis[${JSON.stringify(key)}]?.check() === true`)
            if (!sameTarget || ended || !current()) { finish(); notice(); return }
            contents[item.action]()
            finish()
          } catch { finish(); notice() }
        })()
      } })))
      const origin = owner.origin?.() ?? { x: 0, y: 0 }
      menu.popup({ window, frame, x: Math.round(origin.x + params.x), y: Math.round(origin.y + params.y),
        callback: () => { if (!chosen) finish() } })
    } catch { finish(); notice() }
  }
  const listener = (event: Electron.Event, params: ContextMenuParams) => {
    void open(event, params).catch(() => console.warn('Text menu target is unavailable; the original page remains usable.'))
  }
  contents.on('context-menu', listener)
  const dispose = () => {
    if (disposed) return
    disposed = true
    pending?.()
    contents.removeListener('context-menu', listener)
    contents.removeListener('destroyed', dispose)
  }
  contents.once('destroyed', dispose)
  return dispose
}
