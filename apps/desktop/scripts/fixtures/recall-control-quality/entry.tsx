import { createClientUiRoot } from '../../../test/helpers/client-ui-render'
import { flushSync } from 'react-dom'
import { App } from '../../../src/renderer/src/App'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { changeNotebook } from '../../../src/renderer/src/lib/notebook-library'
import { prepareNotebookWorkface } from '../../../src/renderer/src/lib/recall-notebooks'
import { NOTES_WORKSPACE_ID } from '../../../src/shared/notes-library'
import { newNoteDocument } from '../../../src/shared/note-document'
import '../../../src/renderer/src/styles/index.css'
import { fixturePath } from '../../lib/fixture-values.mjs'

// Normalize controlled transport resources before the real initialization and spatial writer.
const getConfig = api.config.get, getSnapshot = api.sessions.snapshot
api.config.get = async () => { const config = await getConfig(); return { ...config, workspaces: config.workspaces.map(w => ({ ...w, path: w.path.startsWith('/') ? w.path : fixturePath('preview/' + w.path) })) } }
api.sessions.snapshot = async () => { const snapshot = await getSnapshot(); return { ...snapshot, sessions: snapshot.sessions.map(s => ({ ...s, workspacePath: s.workspacePath.startsWith('/') ? s.workspacePath : fixturePath('preview/' + s.workspacePath) })) } }
await useAppStore.getState().initialize()
const initial = useAppStore.getState(), files = new Map<string, string>()
const directory = (await api.notesStorage.inspect()).directory
const workspace = { id: NOTES_WORKSPACE_ID, name: 'Notes', path: directory, hostId: 'local', kind: 'folder' as const }
useAppStore.setState({ initialize: async () => () => {}, loading: false, config: { ...initial.config!, workspaces: [...initial.config!.workspaces.filter(w => w.id !== NOTES_WORKSPACE_ID).map(w => ({ ...w, path: w.path.startsWith('/') ? w.path : fixturePath('preview/' + w.path) })), workspace] },
  sessions: initial.sessions.map(s => ({ ...s, workspacePath: s.workspacePath.startsWith('/') ? s.workspacePath : fixturePath('preview/' + s.workspacePath) })),
  mainSurface: 'recall', recallNotebookId: 'quality-research', recallNoteId: null, recallSidebarCollapsed: false, recallSidebarWidth: 220, error: null,
  environmentWarning: undefined, workbenchSaveWarning: null })
let catalog = await changeNotebook({ kind: 'create', notebookId: 'quality-research', name: 'Research notebook' })
await changeNotebook({ kind: 'create', notebookId: 'quality-reading', name: 'Reading & observations' })
const workface = await prepareNotebookWorkface(catalog.notebooks['quality-research']!, workspace.id)
const titles = ['A quieter place to think', 'Keep the original work intact', 'Small details that make a tool feel finished', 'Notes from a long conversation', 'Questions worth returning to', 'A clear next step']
for (const [index, title] of titles.entries()) {
  const noteId = `quality-note-${index}`, path = `research/${index}.note.json`
  files.set(path, JSON.stringify(newNoteDocument(title + '\n\nKeep the original words, context, and the space to continue.', noteId, `quality-block-${index}`)))
  catalog = await changeNotebook({ kind: 'register', noteId, notebookId: 'quality-research', parentNoteId: index === 1 ? 'quality-note-0' : null,
    title, resource: { hostId: 'local', workspaceId: workspace.id, workspacePath: workspace.path, path }, workface })
}
const readFile = api.files.read
api.files.read = async (id, path) => files.has(path) ? { status: 'read', document: { path, content: files.get(path)!, revision: 'fixture-original' } } : readFile(id, path)
const root = createClientUiRoot(document.getElementById('root')!)
root.render(<App />)
Object.assign(window, { recallQuality: {
  ready: true,
  theme: (appAppearance: 'dark' | 'light') => flushSync(() => useAppStore.setState(state => ({ config: { ...state.config!, appearance: { ...state.config!.appearance, appAppearance } } }))),
  notice: () => flushSync(() => useAppStore.setState({ workbenchSaveWarning: 'The storage folder is temporarily unavailable.' })),
  facts: () => { const s = useAppStore.getState(); return { book: s.recallNotebookId, note: s.recallNoteId, tabs: s.tabs, layouts: s.layouts, dirty: s.dirtyDocuments } },
  launcher: () => { const s=useAppStore.getState(), workspaceId=s.config!.workspaces.find(w=>w.id!==NOTES_WORKSPACE_ID)!.id; s.setMainSurface('workbench'); useAppStore.setState({ projectRailOpen: false, toolsOpen: false, workbenchSaveWarning: null }); return s.openLauncher({ workspaceId, reveal: true }) },
  focus: () => useAppStore.getState().setMainSurface('agents')
} })
