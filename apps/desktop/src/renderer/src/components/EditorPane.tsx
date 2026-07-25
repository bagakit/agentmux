import '../monaco'
import Editor, { type OnMount } from '@monaco-editor/react'
import { AlertTriangle, RefreshCw, Save } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { detectLanguage } from '../lib/language-detect'
import { documentKey, type FileWorkbenchSurface } from '../lib/workbench-tabs'
import { useAppStore } from '../store'

type MonacoStandaloneEditor = Parameters<OnMount>[0]

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
      <section className="pane-state pane-state--error">
        <strong>File is no longer available</strong>
        <span>Refresh the explorer and open it again.</span>
      </section>
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
