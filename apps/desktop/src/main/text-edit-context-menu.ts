import { mintCapabilityToken } from '@agentmux/core/object-id'
import { Menu, webContents, type BrowserWindow, type ContextMenuParams, type WebContents, type WebFrameMain } from 'electron'
import { browserPageMenu, type BrowserMenuAction, type BrowserMenuCommands, type BrowserPageMenuTemplate } from './browser-page-context-menu.js'

type MenuOwner = {
  isCurrent(): boolean
  origin?(): { x: number; y: number }
  pageCommands?(hit: ContextMenuParams): BrowserMenuCommands
  presentPageMenu?(window: BrowserWindow, at: { x: number; y: number }, items: BrowserPageMenuTemplate[], isCurrent: () => boolean, finish: () => void): (() => void) | undefined
  onPageActionError?(error: unknown): void
}

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
export function installTextEditContextMenu(contents: WebContents, host: BrowserWindow | (() => BrowserWindow), owner: MenuOwner): () => void {
  let disposed = false
  let pending: (() => void) | undefined
  const ownerWindow = () => typeof host === 'function' ? host() : host
  const live = (window: BrowserWindow) => !disposed && ownerWindow() === window && !contents.isDestroyed() && !window.isDestroyed() && window.isVisible() && !window.isMinimized() && owner.isCurrent()
  const focused = (window: BrowserWindow) => live(window) && window.isFocused() && webContents.getFocusedWebContents() === contents

  const open = async (_event: Electron.Event, params: ContextMenuParams): Promise<void> => {
    pending?.()
    const window = ownerWindow()
    if (!focused(window) || !window.isFocused()) return
    const frame = params.frame
    if (!frame || frame.isDestroyed() || frame.detached || webContents.fromFrame(frame) !== contents) return
    const commands = owner.pageCommands?.(params), flags = params.editFlags
    const actions: Array<{ run: () => void; label: string; enabled: boolean }> = params.isEditable
      ? [...(commands && (flags.canUndo || flags.canRedo) ? [
          { run: () => contents.undo(), label: 'Undo', enabled: flags.canUndo },
          { run: () => contents.redo(), label: 'Redo', enabled: flags.canRedo }] : []),
          { run: () => contents.cut(), label: 'Cut', enabled: flags.canCut },
          { run: () => contents.copy(), label: 'Copy', enabled: flags.canCopy },
          { run: () => contents.paste(), label: 'Paste', enabled: flags.canPaste },
          ...(commands && flags.canEditRichly ? [{ run: () => contents.pasteAndMatchStyle(), label: 'Paste and Match Style', enabled: flags.canPaste }] : []),
          ...(commands && flags.canDelete ? [{ run: () => contents.delete(), label: 'Delete', enabled: true }] : []),
          { run: () => contents.selectAll(), label: 'Select All', enabled: flags.canSelectAll },
          ...(commands && params.misspelledWord && params.spellcheckEnabled && params.formControlType !== 'input-password'
            ? [...(params.dictionarySuggestions ?? []).map(suggestion => ({ run: () => contents.replaceMisspelling(suggestion), label: suggestion, enabled: true })),
                { run: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord), label: 'Add to Dictionary', enabled: true }] : [])]
      : params.selectionText.length > 0 && flags.canCopy
        ? [{ run: () => contents.copy(), label: commands ? 'Copy Text' : 'Copy', enabled: true },
            ...(commands && process.platform === 'darwin' && params.selectionText.trim()
              ? [{ run: () => contents.showDefinitionForSelection(), label: 'Look Up', enabled: true }] : [])] : []
    if (actions.length === 0 && !commands) return
    const ancestors: Array<{ frame: WebFrameMain; token: string }> = []
    for (let current: WebFrameMain | null = frame; current; current = current.parent) ancestors.push({ frame: current, token: current.frameToken })
    const key = `__agentmuxTextEdit_${mintCapabilityToken()}`
    let ended = false, chosen = false, menu: Menu | undefined, releasePresentation: (() => void) | undefined
    const cleanup: Array<() => void> = []
    const currentFrame = () => (releasePresentation ? live(window) && window.isFocused() : focused(window)) && ancestors.every((original, index) =>
      !original.frame.isDestroyed() && !original.frame.detached && original.frame.frameToken === original.token && original.frame.parent === (ancestors[index + 1]?.frame ?? null))
    const current = () => currentFrame() && contents.focusedFrame === frame
    let captureStarted = false
    const finish = () => {
      if (ended) return
      ended = true
      for (const remove of cleanup) remove()
      if (pending === finish) pending = undefined
      releasePresentation?.()
      if (menu) { try { menu.closePopup(window) } catch { /* Only this menu is being released. */ } }
      if (captureStarted && !frame.isDestroyed() && !frame.detached) void frame.executeJavaScript(`globalThis[${JSON.stringify(key)}]?.dispose()`).catch(() => {})
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
      if (!focused(window) || frame.isDestroyed() || frame.detached) return
      const origin = owner.origin?.() ?? { x: 0, y: 0 }
      try {
        Menu.buildFromTemplate([{ label: 'Text target changed or unavailable. Open its menu again.', enabled: false }]).popup({
          window, frame, x: Math.round(origin.x + params.x), y: Math.round(origin.y + params.y) })
      } catch { console.warn('Text editing menu is unavailable; the original input and native keyboard editing remain available.') }
    }
    try {
      const runPageAction = (action: BrowserMenuAction) => {
        if (chosen || ended || !currentFrame() || !commands?.isCurrent()) { finish(); return false }
        chosen = true
        if (releasePresentation) contents.focus()
        finish()
        try { void Promise.resolve(action()).catch(error => owner.onPageActionError?.(error)) }
        catch (error) { owner.onPageActionError?.(error) }
        return true
      }
      const items = commands ? browserPageMenu(contents, params, commands, runPageAction) : []
      if (actions.length > 0) {
        captureStarted = true
        let captured = false
        try { captured = await evaluate(captureTargetScript(key, params.isEditable)) } catch { /* The address actions use the original native hit. */ }
        if (ended) return
        if (captured && current()) {
          if (items.length > 0) items.push({ type: 'separator' })
          items.push(...actions.map(item => ({ label: item.label, enabled: item.enabled, click: () => {
            if (chosen || ended || !item.enabled) return false
            if (!currentFrame() || commands && !commands.isCurrent()) { finish(); return false }
            chosen = true
            if (releasePresentation) contents.focus()
            void (async () => {
              try {
                const sameTarget = await evaluate(`globalThis[${JSON.stringify(key)}]?.check() === true`)
                if (!sameTarget || ended || !focused(window) || !current() || commands && !commands.isCurrent()) { finish(); notice(); return }
                item.run()
                finish()
              } catch { finish(); notice() }
            })()
          } })))
        } else if (items.length === 0) { finish(); notice(); return }
        else items.push({ type: 'separator' }, { label: 'Text target changed or unavailable. Open its menu again.', enabled: false })
      }
      if (!currentFrame()) { finish(); return }
      if (commands) {
        const selection = params.formControlType !== 'input-password' && params.selectionText.trim()
        if (selection) items.push({ label: 'Search for Selected Text', click: () => runPageAction(commands.search(selection)) })
        if (items.length) items.push({ type: 'separator' })
        items.push({ label: 'Inspect', click: () => runPageAction(commands.inspect) })
      }
      const origin = owner.origin?.() ?? { x: 0, y: 0 }
      const at = { x: Math.round(origin.x + params.x), y: Math.round(origin.y + params.y) }
      // Editable fields keep their native menu and input responder throughout.
      if (commands && !params.isEditable) releasePresentation = owner.presentPageMenu?.(window, at, items, () => currentFrame() && commands.isCurrent(), finish)
      if (releasePresentation) {
        window.on('blur', finish)
        cleanup.push(() => window.removeListener('blur', finish))
        return
      }
      menu = Menu.buildFromTemplate(items)
      menu.popup({ window, frame, ...at,
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
