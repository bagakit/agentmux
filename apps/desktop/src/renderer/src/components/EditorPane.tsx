import '../monaco'
import Editor, { type OnMount } from '@monaco-editor/react'
import { AlertTriangle, FolderOpen, RefreshCw, Save } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { api } from '../lib/api'
import { detectLanguage } from '../lib/language-detect'
import { documentKey, type FileWorkbenchSurface } from '../lib/workbench-tabs'
import { useAppStore } from '../store'

type MonacoStandaloneEditor = Parameters<OnMount>[0]

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
          <FolderOpen size={13} /> Reveal in Finder
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

export function EditorPane({ tabId, surface }: { tabId: string; surface: FileWorkbenchSurface }) {
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
  const conflict = issue?.kind === 'changed' || issue?.kind === 'deleted'
  const editorRef = useRef<MonacoStandaloneEditor | null>(null)

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
    if (editorRef.current && revealTarget) consumeRevealTarget(editorRef.current)
    // consumeRevealTarget reads the latest target from the store; revealTarget only drives when.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealTarget, key])

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
          {conflict ? (
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
        <Editor
          path={`${surface.workspaceId}:${document.path}`}
          language={detectLanguage(document.path)}
          value={document.content}
          onChange={(value) => update(tabId, value ?? '', surface.regionId)}
          onMount={(editor) => {
            editorRef.current = editor
            consumeRevealTarget(editor)
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
            wordWrap: 'off'
          }}
        />
      </div>
    </section>
  )
}
