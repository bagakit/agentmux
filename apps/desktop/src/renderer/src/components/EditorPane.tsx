import '../monaco'
import Editor from '@monaco-editor/react'
import { AlertTriangle, RefreshCw, Save } from 'lucide-react'
import { detectLanguage } from '../lib/language-detect'
import { documentKey, type FileWorkbenchSurface } from '../lib/workbench-tabs'
import { useAppStore } from '../store'

export function EditorPane({ tabId, surface }: { tabId: string; surface: FileWorkbenchSurface }) {
  const document = useAppStore((state) => {
    return state.documents[documentKey(surface.workspaceId, surface.path)] ?? null
  })
  const dirty = useAppStore((state) => {
    return Boolean(state.dirtyDocuments[documentKey(surface.workspaceId, surface.path)])
  })
  const issue = useAppStore((state) => {
    return state.documentIssues[documentKey(surface.workspaceId, surface.path)]
  })
  const saving = useAppStore((state) => {
    return Boolean(state.savingDocuments[documentKey(surface.workspaceId, surface.path)])
  })
  const update = useAppStore((state) => state.updateDocument)
  const save = useAppStore((state) => state.saveDocument)
  const reload = useAppStore((state) => state.reloadDocument)
  const overwrite = useAppStore((state) => state.overwriteDocument)
  const conflict = issue?.kind === 'changed' || issue?.kind === 'deleted'

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
