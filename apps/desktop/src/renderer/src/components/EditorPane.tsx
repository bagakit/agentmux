import Editor from '@monaco-editor/react'
import { Save } from 'lucide-react'
import { useAppStore } from '../store'

function language(path: string): string {
  if (/\.(ts|tsx)$/.test(path)) return 'typescript'
  if (/\.(js|jsx|mjs|cjs)$/.test(path)) return 'javascript'
  if (/\.jsonc?$/.test(path)) return 'json'
  if (/\.md$/.test(path)) return 'markdown'
  if (/\.css$/.test(path)) return 'css'
  if (/\.ya?ml$/.test(path)) return 'yaml'
  return 'plaintext'
}

export function EditorPane() {
  const document = useAppStore((state) => state.activeDocument)
  const dirty = useAppStore((state) => state.documentDirty)
  const update = useAppStore((state) => state.updateDocument)
  const save = useAppStore((state) => state.saveDocument)
  if (!document) {
    return (
      <section className="editor-empty">
        <div className="editor-empty__glyph">⌘</div>
        <strong>Open a file beside the agent</strong>
        <span>Changes stay rooted to this workspace.</span>
      </section>
    )
  }
  return (
    <section className="editor-pane">
      <header className="editor-header">
        <span>{document.path}</span>
        <button className="small-button" disabled={!dirty} onClick={() => void save()}>
          <Save size={13} /> {dirty ? 'Save' : 'Saved'}
        </button>
      </header>
      <div className="editor-canvas">
        <Editor
          path={document.path}
          language={language(document.path)}
          value={document.content}
          onChange={(value) => update(value ?? '')}
          theme="vs-dark"
          options={{
            minimap: { enabled: false },
            fontFamily: '"SFMono-Regular", "Cascadia Code", monospace',
            fontSize: 13,
            lineHeight: 21,
            padding: { top: 16 },
            scrollBeyondLastLine: false,
            automaticLayout: true,
            renderLineHighlight: 'gutter',
            smoothScrolling: true
          }}
        />
      </div>
    </section>
  )
}
