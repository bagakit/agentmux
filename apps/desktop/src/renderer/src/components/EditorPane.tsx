import '../monaco'
import Editor, { DiffEditor, type OnMount } from '@monaco-editor/react'
import { AlertTriangle, FolderOpen, GitCompare, RefreshCw, Save, WrapText } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { api } from '../lib/api'
import { copyTextToClipboard } from '../lib/clipboard-copy'
import { applyCopyPathStyle } from '../lib/copy-path-display'
import { diffEditorSides, wordWrapOption } from '../lib/editor-diff'
import { revealInFileManagerLabel } from '../lib/host-platform'
import {
  EDITOR_COPY_ACTIONS,
  EDITOR_COPY_MENU_GROUP,
  MULTILINE_SELECTION_CONTEXT_KEY,
  hasMultilineSelection,
  type CopyActionInput
} from '../lib/editor-copy-actions'
import { editorSaveAction } from '../lib/editor-save-shortcut'
import { detectLanguage } from '../lib/language-detect'
import { bindingById, monacoKeybindingFor } from '../lib/shortcut-registry'
import { regionCaretFocusTargets } from '../lib/region-focus'
import { documentKey, type FileWorkbenchSurface } from '../lib/workbench-tabs'
import { useAppStore, type EditorRegionDiffState } from '../store'
import { EditorReleasedState } from './EditorReleasedState'

type MonacoStandaloneEditor = Parameters<OnMount>[0]
type MonacoApi = Parameters<OnMount>[1]

// Monaco's own command-palette action id. Its palette is the only surface that can state a built-in's
// keybinding (the public API has no reader for it), so this is the one Monaco id we depend on by name.
const MONACO_COMMAND_PALETTE_ACTION_ID = 'editor.action.quickCommand'

// The failure state of a file surface. It stays hookless so it can be exercised without a Monaco
// render context: the reveal action is the one output an unopenable file must still offer, and the
// only escape hatch that answers "is it actually still there?". Absent — not disabled — when reveal
// cannot work, because a button that is guaranteed to error is not an offer.
export function EditorUnavailableState({
  canReveal,
  onReveal
}: {
  canReveal: boolean
  onReveal: () => void
}) {
  return (
    <section className="pane-state pane-state--error">
      <strong>File is no longer available</strong>
      <span>Refresh the explorer and open it again.</span>
      {canReveal ? (
        <button className="small-button" onClick={onReveal}>
          <FolderOpen size={13} /> {revealInFileManagerLabel()}
        </button>
      ) : null}
    </section>
  )
}

// Routes the failure-state reveal through the SAME channel the file tree uses (api.files.reveal →
// files:reveal → localPathForReveal). A deleted target is handled downstream by falling back to its
// nearest existing ancestor, so this stays a plain call; when reveal still cannot land, the error
// surfaces on the shared reportError banner rather than replacing the pane with a second dead end.
export async function revealFileInFileManager(
  workspaceId: string,
  path: string,
  reportError: (error: unknown) => void
): Promise<void> {
  try {
    await api.files.reveal(workspaceId, path)
  } catch (error) {
    reportError(error)
  }
}

// The HEAD-vs-worktree diff view of a file Region. Kept a separate component from EditorPane's edit
// path so the two Monaco components (`Editor` and `DiffEditor`) never share a mount, and so the diff's
// loading / error / binary / no-changes states are assertable without a document behind them.
//
// The two sides come from the store's already-loaded git:diff payload (HEAD blob vs worktree file) via
// the diffEditorSides seam — this component never re-derives directionality. Monaco's own DiffEditor
// handles large-diff degradation (it caps side-by-side rendering and falls back to inline) internally;
// we do not reimplement that. A binary file has no text to diff, so it shows a placeholder rather than
// feeding two empty strings to the diff (which reads as "no changes").
function EditorDiffCanvas({
  diff,
  wordWrap,
  language
}: {
  diff: EditorRegionDiffState | undefined
  wordWrap: boolean
  language: string
}) {
  if (!diff || (diff.loading && !diff.diff)) {
    return (
      <section className="pane-state">
        <span>Loading diff…</span>
      </section>
    )
  }
  if (diff.error && !diff.diff) {
    return (
      <section className="pane-state pane-state--error">
        <AlertTriangle size={14} />
        <strong>Could not load diff</strong>
        <span>{diff.error}</span>
      </section>
    )
  }
  if (!diff.diff) {
    return (
      <section className="pane-state">
        <span>No diff available.</span>
      </section>
    )
  }
  if (diff.diff.binary) {
    return (
      <section className="pane-state">
        <span>Binary file — no textual diff to show.</span>
      </section>
    )
  }
  const sides = diffEditorSides(diff.diff)
  return (
    <DiffEditor
      original={sides.original}
      modified={sides.modified}
      language={language}
      theme="vs-dark"
      options={{
        readOnly: true,
        // Monaco decides side-by-side vs inline from width; leaving renderSideBySide default lets its own
        // large-diff degradation stand. We only assert the sides are fed correctly, not how it lays out.
        minimap: { enabled: false },
        fontFamily: '"SFMono-Regular", "Cascadia Code", monospace',
        fontSize: 14,
        lineHeight: 21,
        scrollBeyondLastLine: false,
        automaticLayout: true,
        wordWrap: wordWrapOption(wordWrap)
      }}
    />
  )
}

export function EditorPane({
  tabId,
  surface,
  released = false,
  visible = true
}: {
  tabId: string
  surface: FileWorkbenchSurface
  released?: boolean
  visible?: boolean
}) {
  const key = documentKey(surface.workspaceId, surface.path)
  const document = useAppStore((state) => {
    return state.documents[key] ?? null
  })
  const dirty = useAppStore((state) => {
    return Boolean(state.dirtyDocuments[key])
  })
  const issue = useAppStore((state) => {
    return state.documentIssues[key]
  })
  const saving = useAppStore((state) => {
    return Boolean(state.savingDocuments[key])
  })
  const revealTarget = useAppStore((state) => state.documentRevealTargets[key])
  const update = useAppStore((state) => state.updateDocument)
  const save = useAppStore((state) => state.saveDocument)
  const reload = useAppStore((state) => state.reloadDocument)
  const overwrite = useAppStore((state) => state.overwriteDocument)
  const clearRevealTarget = useAppStore((state) => state.clearDocumentRevealTarget)
  const isLocalWorkspace = useAppStore((state) =>
    state.config?.workspaces.find((item) => item.id === surface.workspaceId)?.hostId === 'local'
  )
  const reportError = useAppStore((state) => state.reportError)
  const attachPersistedDocument = useAppStore((state) => state.attachPersistedFileDocument)
  const regionCaretFocus = useAppStore((state) =>
    regionCaretFocusTargets(state.regionCaretFocus, surface.regionId) ? state.regionCaretFocus : null)
  const clearRegionCaretFocus = useAppStore((state) => state.clearRegionCaretFocus)
  // Word wrap is one global viewing preference (like a theme), not a document property: it is read
  // here and mapped to Monaco's enum through the single wordWrapOption seam, so the option is
  // controlled/reactive rather than a mount-time constant.
  const wordWrap = useAppStore((state) => state.editorWordWrap)
  const toggleWordWrap = useAppStore((state) => state.toggleEditorWordWrap)
  // Diff is a display MODE of this same file Region, not a separate surface kind: it carries no
  // identity beyond the file it compares, so it lives as per-Region ephemeral state keyed by regionId
  // (never persisted — a diff depends on git HEAD and is transient; reopening returns to edit).
  const regionMode = useAppStore((state) => state.editorRegionModes[surface.regionId] ?? 'edit')
  const regionDiff = useAppStore((state) => state.editorRegionDiffs[surface.regionId])
  const setRegionMode = useAppStore((state) => state.setEditorRegionMode)
  const reloadDiff = useAppStore((state) => state.reloadRegionDiff)
  const conflict = issue?.kind === 'changed' || issue?.kind === 'deleted'
  const editorRef = useRef<MonacoStandaloneEditor | null>(null)
  const visibleRef = useRef(visible)
  visibleRef.current = visible

  // A file Region restored from persistence arrives with no document behind it: the surface is only
  // {regionId,kind,workspaceId,path}, and every other way a file Region appears loads its document as
  // part of opening it. Without this the Tab is present and reports "unavailable" — which reads as a
  // broken file rather than an unloaded one. Asking for it here, from the very pane that would render
  // that state, is what makes a Region in a Workspace the user has not switched back to yet work too.
  //
  // Hidden Tabs stay mounted by design (that is what keeps terminal instances alive across switches),
  // so this fires for every restored file Region in the group, not only the visible one. That is the
  // accepted cost: one read per open file Region, and every restored Tab works on first click.
  //
  // Guarded on `issue`, not just on `document`: a read that failed (the file was deleted while the app
  // was closed, or the read errored) records the reason and leaves `document` null, so without that
  // guard this would re-read a known-unreadable path on every dependency change. The user's route out
  // of that state is the Reveal action below, not a silent retry.
  useEffect(() => {
    if (document || issue || released) return
    void attachPersistedDocument(surface.workspaceId, surface.path)
  }, [document, issue, released, attachPersistedDocument, surface.workspaceId, surface.path])

  // Consume a one-shot reveal target (set when the file was opened with a :line location, e.g. a
  // terminal path link). Both entry points call this: `onMount` handles the first open (Monaco
  // loads async, so the editor may not exist when the effect below first runs), and the effect
  // handles a fresh target arriving for an already-mounted editor (re-clicking a link).
  function consumeRevealTarget(editor: MonacoStandaloneEditor): void {
    const target = useAppStore.getState().documentRevealTargets[key]
    if (!target) return
    editor.revealLineInCenter(target.line)
    editor.setPosition({ lineNumber: target.line, column: target.column ?? 1 })
    editor.focus()
    clearRevealTarget(key)
  }

  useEffect(() => {
    // A released Region has no live Monaco owner. In particular, do not replay a stale reveal
    // target into the disposed instance while the parked placeholder is mounted.
    if (released || !document) {
      editorRef.current = null
      return
    }
    if (editorRef.current && revealTarget) consumeRevealTarget(editorRef.current)
    // consumeRevealTarget reads the latest target from the store; revealTarget only drives when.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealTarget, key, released, Boolean(document)])

  // Monaco mounts asynchronously. Keep the intent until a live editor can take it, and read
  // current store state at consumption so a late mount cannot replay an obsolete request.
  function consumeCaretFocus(): void {
    const request = useAppStore.getState().regionCaretFocus
    if (!regionCaretFocusTargets(request, surface.regionId)) return
    if (!visibleRef.current) {
      clearRegionCaretFocus(request.nonce)
      return
    }
    if (!editorRef.current) return
    editorRef.current.focus()
    clearRegionCaretFocus(request.nonce)
  }

  useEffect(() => {
    consumeCaretFocus()
  }, [regionCaretFocus, visible, released])

  if (released) return <EditorReleasedState />

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

  if (!document) {
    return (
      <EditorUnavailableState
        canReveal={isLocalWorkspace}
        onReveal={() => void revealFileInFileManager(surface.workspaceId, surface.path, reportError)}
      />
    )
  }

  return (
    <section
      className={`editor-pane ${issue ? 'editor-pane--issue' : ''}`}
      data-file-state={issue?.kind ?? (saving ? 'saving' : dirty ? 'dirty' : 'clean')}
    >
      <header className="editor-header">
        <span title={document.path}>{document.path}</span>
        <div className="editor-header__actions">
          {/* Word wrap: a discoverable entry point for the Alt+Z chord, reflecting the global bit.
              aria-pressed makes the toggle state legible to the behavior test and to screen readers. */}
          <button
            className={`small-button ${wordWrap ? 'small-button--active' : ''}`}
            aria-pressed={wordWrap}
            title="Toggle word wrap (Alt+Z)"
            onClick={() => toggleWordWrap()}
          >
            <WrapText size={13} /> Wrap
          </button>
          {/* Diff is a display mode of this file Region, not a separate tab. This toggles between the
              editable buffer and the HEAD-vs-worktree diff of the same file. */}
          <button
            className={`small-button ${regionMode === 'diff' ? 'small-button--active' : ''}`}
            aria-pressed={regionMode === 'diff'}
            title="Toggle diff against HEAD"
            onClick={() =>
              void setRegionMode(
                surface.regionId,
                surface.workspaceId,
                surface.path,
                regionMode === 'diff' ? 'edit' : 'diff'
              )
            }
          >
            <GitCompare size={13} /> Diff
          </button>
          {regionMode === 'diff' ? (
            <button
              className="small-button"
              disabled={Boolean(regionDiff?.loading)}
              title="Reload diff"
              onClick={() => void reloadDiff(surface.regionId, surface.workspaceId, surface.path)}
            >
              <RefreshCw size={13} /> {regionDiff?.loading ? 'Loading…' : 'Refresh'}
            </button>
          ) : conflict ? (
            <>
              <button className="small-button" disabled={saving} onClick={() => void reload(tabId, surface.regionId)}>
                <RefreshCw size={13} /> Reload
              </button>
              <button className="small-button small-button--warning" disabled={saving} onClick={() => void overwrite(tabId, surface.regionId)}>
                <Save size={13} /> {saving ? 'Overwriting…' : 'Overwrite'}
              </button>
            </>
          ) : issue?.kind === 'read-error' ? (
            <button className="small-button" disabled={saving} onClick={() => void reload(tabId, surface.regionId)}>
              <RefreshCw size={13} /> Retry
            </button>
          ) : (
            <button className="small-button" disabled={!dirty || saving} onClick={() => void save(tabId, surface.regionId)}>
              <Save size={13} /> {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
            </button>
          )}
        </div>
      </header>
      {issue ? (
        <div className={`editor-file-notice editor-file-notice--${issue.kind}`} role="alert">
          <AlertTriangle size={13} />
          <span>
            {issue.kind === 'changed'
              ? 'File changed on disk. Your draft is preserved.'
              : issue.kind === 'deleted'
                ? 'File was deleted on disk. Reload accepts the deletion; Overwrite recreates it.'
                : issue.kind === 'read-error'
                  ? `Could not refresh the file (${issue.message}). The last buffer is preserved.`
                  : `Save failed (${issue.message}). Your draft is still unsaved.`}
          </span>
        </div>
      ) : null}
      <div className="editor-canvas">
        {regionMode === 'diff' ? (
          <EditorDiffCanvas diff={regionDiff} wordWrap={wordWrap} language={detectLanguage(document.path)} />
        ) : (
          <Editor
            path={`${surface.workspaceId}:${document.path}`}
            language={detectLanguage(document.path)}
            value={document.content}
            onChange={(value) => update(tabId, value ?? '', surface.regionId)}
            onMount={(editor, monaco) => {
              editorRef.current = editor
              // Monaco owns the editor lifetime. Clear only the instance that disposed itself so a
              // late dispose from an old Region cannot erase a newer editor reference after restore.
              editor.onDidDispose(() => {
                if (editorRef.current === editor) editorRef.current = null
              })
              registerSaveShortcut(editor, monaco)
              registerWordWrapShortcut(editor, monaco)
              registerCommandPaletteShortcut(editor, monaco)
              registerCopyActions(editor, monaco)
              consumeRevealTarget(editor)
              consumeCaretFocus()
            }}
            theme="vs-dark"
            options={{
              minimap: { enabled: false },
              fontFamily: '"SFMono-Regular", "Cascadia Code", monospace',
              fontSize: 14,
              lineHeight: 21,
              padding: { top: 14 },
              scrollBeyondLastLine: false,
              automaticLayout: true,
              renderLineHighlight: 'gutter',
              smoothScrolling: true,
              wordWrap: wordWrapOption(wordWrap)
            }}
          />
        )}
      </div>
    </section>
  )
}
