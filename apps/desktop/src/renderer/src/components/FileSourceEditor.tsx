import '../monaco'
import Editor, { type OnMount } from '@monaco-editor/react'
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { copyTextToClipboard } from '../lib/clipboard-copy'
import { applyCopyPathStyle } from '../lib/copy-path-display'
import { wordWrapOption } from '../lib/editor-diff'
import { EDITOR_COPY_ACTIONS, EDITOR_COPY_MENU_GROUP, MULTILINE_SELECTION_CONTEXT_KEY,
  hasMultilineSelection, type CopyActionInput } from '../lib/editor-copy-actions'
import { editorSaveAction } from '../lib/editor-save-shortcut'
import { detectLanguage } from '../lib/language-detect'
import { useMonacoTheme } from '../hooks/useMonacoTheme'
import { useEditorTypography } from '../hooks/useEditorTypography'
import { bindingById, monacoKeybindingFor } from '../lib/shortcut-registry'
import { regionCaretFocusTargets } from '../lib/region-focus'
import { desktopElementVisible } from '../lib/desktop-presentation'
import { documentKey, type FileWorkbenchSurface } from '../lib/workbench-tabs'
import { useAppStore } from '../store'
import { cancelFileRegionFormat, formatFileRegion, registerFileRegionFormatter } from '../lib/file-formats/format-file-region'
import { monacoFormatAdapter } from '../lib/file-formats/monaco-format-adapter'
import { canFormatFile } from '../lib/file-formats/format-support'

type MonacoStandaloneEditor = Parameters<OnMount>[0]
type MonacoApi = Parameters<OnMount>[1]

// Monaco's own command-palette action id. Its palette is the only surface that can state a built-in's
// keybinding (the public API has no reader for it), so this is the one Monaco id we depend on by name.
const MONACO_COMMAND_PALETTE_ACTION_ID = 'editor.action.quickCommand'

export type FileEditorViewState = { modelPath: string; state: ReturnType<MonacoStandaloneEditor['saveViewState']> }

/** Disposable source projection. The parent Region retains its reading position across modes. */
export function FileSourceEditor({ tabId, surface, visible = true, viewState }: {
  tabId: string; surface: FileWorkbenchSurface; visible?: boolean
  viewState: RefObject<FileEditorViewState | null>
}) {
  const key = documentKey(surface.workspaceId, surface.path)
  const document = useAppStore(state => state.documents[key])
  const revealTarget = useAppStore(state => state.documentRevealTargets[key])
  const update = useAppStore(state => state.updateDocument)
  const clearRevealTarget = useAppStore(state => state.clearDocumentRevealTarget)
  const regionCaretFocus = useAppStore(state =>
    regionCaretFocusTargets(state.regionCaretFocus, surface.regionId) ? state.regionCaretFocus : null)
  const clearRegionCaretFocus = useAppStore(state => state.clearRegionCaretFocus)
  const wordWrap = useAppStore(state => state.editorWordWrap)
  const minimap = useAppStore(state => state.editorMinimap)
  const monacoTheme = useMonacoTheme()
  const typography = useEditorTypography()
  const editorRef = useRef<MonacoStandaloneEditor | null>(null)
  const unregisterFormatter = useRef<(() => void) | null>(null)
  // Per-Region URIs keep a preview switch from disposing another Region's model.
  const modelPath = `agentmux-file:///${encodeURIComponent(surface.regionId)}/${encodeURIComponent(key)}`
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  useLayoutEffect(() => () => {
    unregisterFormatter.current?.()
    unregisterFormatter.current = null
    const editor = editorRef.current
    if (!editor?.getModel()) return
    viewState.current = { modelPath, state: editor.saveViewState() }
    editorRef.current = null
  }, [modelPath, viewState])
  useEffect(() => { if (!visible) cancelFileRegionFormat(surface.regionId) }, [visible, surface.regionId])

  // Consume a one-shot reveal target (set when the file was opened with a :line location, e.g. a
  // terminal path link). Both entry points call this: `onMount` handles the first open (Monaco
  // loads async, so the editor may not exist when the effect below first runs), and the effect
  // handles a fresh target arriving for an already-mounted editor (re-clicking a link).
  function consumeRevealTarget(editor: MonacoStandaloneEditor): void {
    const target = useAppStore.getState().documentRevealTargets[key]
    if (!target || target.noteBlock) return
    editor.revealLineInCenter(target.line)
    editor.setPosition({ lineNumber: target.line, column: target.column ?? 1 })
    editor.focus()
    clearRevealTarget(key)
  }

  useEffect(() => {
    // A removed document has no live source owner. Never replay into a disposed instance.
    if (!document) {
      editorRef.current = null
      return
    }
    if (editorRef.current && revealTarget) consumeRevealTarget(editorRef.current)
    // consumeRevealTarget reads the latest target from the store; revealTarget only drives when.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealTarget, key, Boolean(document)])

  // Monaco mounts asynchronously. Keep the intent until a live editor can take it, and read
  // current store state at consumption so a late mount cannot replay an obsolete request.
  function consumeCaretFocus(): void {
    const request = useAppStore.getState().regionCaretFocus
    if (!regionCaretFocusTargets(request, surface.regionId)) return
    if (!visibleRef.current) { clearRegionCaretFocus(request.nonce); return }
    const editor = editorRef.current
    const host = editor?.getContainerDomNode()
    if (!editor || !desktopElementVisible(host ?? null)) return
    editor.focus()
    if (host?.contains(window.document.activeElement)) clearRegionCaretFocus(request.nonce)
  }

  useEffect(() => {
    consumeCaretFocus()
    const nonce = regionCaretFocus?.nonce
    if (nonce === undefined || useAppStore.getState().regionCaretFocus?.nonce !== nonce) return
    // Only the exact pending editor observes mount/inert changes; a later intent cancels it.
    const observer = new MutationObserver(() => {
      if (useAppStore.getState().regionCaretFocus?.nonce !== nonce) return observer.disconnect()
      consumeCaretFocus()
      if (useAppStore.getState().regionCaretFocus?.nonce !== nonce) observer.disconnect()
    })
    observer.observe(window.document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['inert', 'hidden', 'aria-hidden'] })
    return () => observer.disconnect()
  }, [regionCaretFocus, visible])

  // Cmd/Ctrl+S. Registered as a Monaco command rather than a window listener so it fires only for
  // the editor that actually has focus — with several file Regions open at once, a window-level
  // handler would have to guess which one the user meant, and Monaco already knows.
  //
  // The chord comes from the registry's `editor.save` binding, not from a hand-written bitmask. This used
  // to read `monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS`, which made the registry entry decorative: it
  // fed the cheat-sheet while Monaco obeyed this line, so the two could drift and the row would advertise
  // a key that does nothing. A missing binding throws rather than silently registering no shortcut.
  //
  // The handler reads live state through getState() instead of closing over `dirty`/`saving`/`issue`.
  // Monaco keeps the callback given at registration, so a captured value would be whatever it was on
  // mount: the shortcut would decide using a stale view of the file and could write on a conflict it
  // cannot see.
  function registerSaveShortcut(editor: MonacoStandaloneEditor, monaco: MonacoApi): void {
    const binding = bindingById('editor.save')
    if (!binding) throw new Error('editor.save is missing from the shortcut registry; save would have no key')
    editor.addCommand(monacoKeybindingFor(binding, monaco), () => {
      const state = useAppStore.getState()
      const currentKey = documentKey(surface.workspaceId, surface.path)
      const action = editorSaveAction({
        dirty: Boolean(state.dirtyDocuments[currentKey]),
        saving: Boolean(state.savingDocuments[currentKey]),
        ...(state.documentIssues[currentKey] ? { issue: state.documentIssues[currentKey]!.kind } : {})
      })
      // 'conflict' deliberately does nothing: Reload and Overwrite are already on screen, and
      // silently overwriting someone else's change is the one irreversible outcome here.
      if (action === 'save') void state.saveDocument(tabId, surface.regionId)
    })
  }

  // Alt+Z toggles word wrap, matching the near-universal editor chord for it. Registered as a Monaco
  // command (not a window listener) so it only fires for the focused editor, and it calls the store
  // action rather than closing over `wordWrap` — the state bit is global, so a captured mount-time
  // value would go stale the moment another pane flipped it. The chord comes from the registry (same
  // reason as save): a hardcoded bitmask here would make the cheat-sheet's row decorative and free to drift.
  function registerWordWrapShortcut(editor: MonacoStandaloneEditor, monaco: MonacoApi): void {
    const binding = bindingById('editor.toggle-word-wrap')
    if (!binding) throw new Error('editor.toggle-word-wrap is missing from the shortcut registry; wrap toggle would have no key')
    editor.addCommand(monacoKeybindingFor(binding, monaco), () => {
      useAppStore.getState().toggleEditorWordWrap()
    })
  }

  // The discoverability door for everything Monaco already ships: find, replace, go-to-line, go-to-symbol,
  // the multi-cursor commands. All of them are live and keybound (nothing here disables them) — the gap was
  // only that nothing told the user. Rather than re-listing those commands with hand-copied chords (Monaco's
  // public API cannot report a built-in's keybinding, so such rows would be unverifiable and free to drift),
  // this opens Monaco's OWN command palette, which lists every action next to the key Monaco actually obeys.
  //
  // Reached through `getAction` rather than a copy of the palette's keybinding: the id is Monaco's stable
  // action id, and a missing action throws instead of registering a chord that silently does nothing.
  function registerCommandPaletteShortcut(editor: MonacoStandaloneEditor, monaco: MonacoApi): void {
    const binding = bindingById('editor.show-commands')
    if (!binding) throw new Error('editor.show-commands is missing from the shortcut registry; the command palette would have no key')
    editor.addCommand(monacoKeybindingFor(binding, monaco), () => {
      const action = editor.getAction(MONACO_COMMAND_PALETTE_ACTION_ID)
      if (!action) throw new Error(`Monaco has no ${MONACO_COMMAND_PALETTE_ACTION_ID} action; the editor command palette is unreachable`)
      void action.run()
    })
  }

  // The editor's own right-click "copy path / path:line / agent-context" actions. Monaco owns the
  // context menu; we add items through addAction rather than drawing our own so keybindings, grouping
  // and the multiline precondition all go through the editor. The WHAT-text of each action lives in
  // editor-copy-actions (pure, testable); this shell only reads the live cursor/selection off Monaco,
  // hands the assembled text to the shared clipboard exit, and keeps the multiline context key fresh.
  function registerCopyActions(editor: MonacoStandaloneEditor, monaco: MonacoApi): void {
    // Monaco decides an action's visibility from its `precondition` context-key expression. The
    // agent-context item must appear only for a multi-line selection, so we own that key and refresh
    // it whenever the selection changes. Same key name as the action's precondition (one constant).
    const multiline = editor.createContextKey<boolean>(MULTILINE_SELECTION_CONTEXT_KEY, false)
    editor.onDidChangeCursorSelection((event) => {
      multiline.set(hasMultilineSelection(event.selection.startLineNumber, event.selection.endLineNumber))
    })

    for (const action of EDITOR_COPY_ACTIONS) {
      editor.addAction({
        id: action.id,
        label: action.label,
        contextMenuGroupId: EDITOR_COPY_MENU_GROUP,
        contextMenuOrder: action.order,
        ...(action.precondition ? { precondition: action.precondition } : {}),
        run: (ed) => {
          const state = useAppStore.getState()
          const currentKey = documentKey(surface.workspaceId, surface.path)
          const doc = state.documents[currentKey]
          if (!doc) return
          const workspace = state.config?.workspaces.find((item) => item.id === surface.workspaceId)
          const workspaceRoot = workspace?.path
          if (workspaceRoot === undefined) return
          const selection = ed.getSelection()
          const model = ed.getModel()
          const startLine = selection?.startLineNumber ?? ed.getPosition()?.lineNumber ?? 1
          const endLine = selection?.endLineNumber ?? startLine
          const input: CopyActionInput = {
            relativePath: doc.path,
            workspaceRoot,
            startLine,
            endLine,
            selectedText: selection && model ? model.getValueInRange(selection) : '',
            fenceLang: detectLanguage(doc.path)
          }
          // 只有本机绝对路径动作才缩写 home；相对/行号/上下文块不含 home 前缀，套上去也是 no-op，
          // 但对非本机 workspace 明确不缩写——本机 home 在对面不存在。
          const built = action.buildText(input)
          const text =
            action.id === 'agentmux.copyAbsolutePath' && workspace?.hostId === 'local'
              ? applyCopyPathStyle(built, { home: state.localHome, copyPathsAsAbsolute: state.config?.copyPathsAsAbsolute })
              : built
          void copyTextToClipboard(text, state.reportError)
        }
      })
    }
  }

  if (!document) return null
  return (
  <Editor
    key={modelPath}
    path={modelPath}
    saveViewState={false}
    language={detectLanguage(document.path)}
    value={document.content}
    onChange={(value) => update(tabId, value ?? '', surface.regionId)}
    onMount={(editor, monaco) => {
      editorRef.current = editor
      unregisterFormatter.current?.()
      const unregister = registerFileRegionFormatter(surface.regionId, monacoFormatAdapter(editor, {
        path: surface.path,
        isLive: () => {
          const current = useAppStore.getState().tabs[tabId]?.regions[surface.regionId]
          return editorRef.current === editor && current?.kind === 'file' && current.workspaceId === surface.workspaceId && current.path === surface.path
        },
        read: () => {
          const state = useAppStore.getState(), current = state.documents[key]
          return current ? { content: current.content, generation: state.documentGenerations[key] ?? 0 } : null
        },
        observe: changed => useAppStore.subscribe((next, previous) => {
          if (next.documents[key] !== previous.documents[key] || next.documentGenerations[key] !== previous.documentGenerations[key] ||
            next.tabs[tabId]?.regions[surface.regionId] !== previous.tabs[tabId]?.regions[surface.regionId]) changed()
        })
      }))
      unregisterFormatter.current = unregister
      if (canFormatFile(surface.path)) editor.addAction({ id: 'agentmux.formatDocument', label: 'Format document',
        contextMenuGroupId: '1_modification', contextMenuOrder: 1, run: async () => {
          const result = await formatFileRegion(surface.regionId)
          if (result.status !== 'formatted' && result.status !== 'unchanged' && result.status !== 'cancelled' && result.message) useAppStore.getState().reportError(new Error(result.message))
        } })
      if (viewState.current?.modelPath === modelPath) {
        editor.restoreViewState(viewState.current.state)
      }
      // Monaco owns the editor lifetime. Clear only the instance that disposed itself so a
      // late dispose from an old Region cannot erase a newer editor reference after restore.
      editor.onDidDispose(() => {
        unregister()
        if (editorRef.current === editor) editorRef.current = null
      })
      registerSaveShortcut(editor, monaco)
      registerWordWrapShortcut(editor, monaco)
      registerCommandPaletteShortcut(editor, monaco)
      registerCopyActions(editor, monaco)
      consumeRevealTarget(editor)
      consumeCaretFocus()
    }}
    theme={monacoTheme}
    options={{
      minimap: { enabled: minimap },
      fontFamily: '"SFMono-Regular", "Cascadia Code", monospace',
      fontSize: typography.fontSize,
      lineHeight: typography.lineHeight,
      padding: { top: 8 },
      scrollBeyondLastLine: false,
      automaticLayout: true,
      renderLineHighlight: 'gutter',
      smoothScrolling: true,
      wordWrap: wordWrapOption(wordWrap)
    }}
  />
  )
}
