import '../monaco'
import Editor from '@monaco-editor/react'
import { Save } from 'lucide-react'
import { detectLanguage } from '../lib/language-detect'
import { documentKey } from '../lib/workbench-tabs'
import { useAppStore } from '../store'

export function EditorPane({ tabId }: { tabId: string }) {
  const tab = useAppStore((state) => state.tabs[tabId])
  const document = useAppStore((state) => {
    if (tab?.kind !== 'file') return null
    return state.documents[documentKey(tab.workspaceId, tab.path)] ?? null
  })
  const dirty = useAppStore((state) => {
    if (tab?.kind !== 'file') return false
    return Boolean(state.dirtyDocuments[documentKey(tab.workspaceId, tab.path)])
  })
  const update = useAppStore((state) => state.updateDocument)
  const save = useAppStore((state) => state.saveDocument)

  if (tab?.kind !== 'file' || !document) {
    return (
      <section className="pane-state pane-state--error">
        <strong>File is no longer available</strong>
        <span>Refresh the explorer and open it again.</span>
      </section>
    )
  }

  return (
    <section className="editor-pane">
      <header className="editor-header">
        <span title={document.path}>{document.path}</span>
        <button className="small-button" disabled={!dirty} onClick={() => void save(tabId)}>
          <Save size={13} /> {dirty ? 'Save' : 'Saved'}
        </button>
      </header>
      <div className="editor-canvas">
        <Editor
          path={`${tab.workspaceId}:${document.path}`}
          language={detectLanguage(document.path)}
          value={document.content}
          onChange={(value) => update(tabId, value ?? '')}
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
