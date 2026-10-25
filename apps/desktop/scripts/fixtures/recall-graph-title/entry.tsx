import { createClientUiRoot } from '../../../test/helpers/client-ui-render'
import { GlobalRecallSurface } from '../../../src/renderer/src/components/GlobalRecallSurface'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { changeNotebook } from '../../../src/renderer/src/lib/notebook-library'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import { fixturePath } from '../../lib/fixture-values.mjs'
import '../../../src/renderer/src/styles/index.css'

// Normalize private transport data at its original config owner before initialization.
const originalConfig = await api.config.get()
await api.config.save({ ...originalConfig, workspaces: originalConfig.workspaces.map(workspace => ({ ...workspace,
  path: workspace.path.startsWith('/') ? workspace.path : fixturePath('preview/' + workspace.path)
})), appearance: { ...originalConfig.appearance, appAppearance: 'dark' } }, originalConfig)
const snapshot = api.sessions.snapshot
api.sessions.snapshot = async () => {
  const value = await snapshot()
  return { ...value, sessions: value.sessions.map(session => ({ ...session,
    workspacePath: session.workspacePath.startsWith('/') ? session.workspacePath : fixturePath('preview/' + session.workspacePath)
  })) }
}
await useAppStore.getState().initialize()
const workspace = useAppStore.getState().config!.workspaces[0]!
const notebookId = 'original-research'
let catalog = await changeNotebook({ kind: 'create', notebookId, name: 'Research notebook' })
for (const [index, title] of ['A quieter place to think', 'Keep the original work intact', 'A clear next step'].entries()) {
  catalog = await changeNotebook({ kind: 'register', notebookId, noteId: `original-note-${index}`, parentNoteId: null,
    title, resource: { workspaceId: workspace.id, hostId: workspace.hostId, workspacePath: workspace.path, path: `research/${index}.note.md` } })
}
useAppStore.setState({ recallNotebookId: notebookId, recallNoteId: null, recallSidebarCollapsed: false, recallSidebarWidth: 220,
  mainSurface: 'recall', loading: false, error: null, environmentWarning: undefined, workbenchSaveWarning: null })
mountThemeRuntime(window, useAppStore.getState().config!.appearance)
const graph = api.notebooks.graph
const calls: { input: Parameters<typeof graph>[0]; signal: boolean; error?: string }[] = []
api.notebooks.graph = async (input, options) => {
  const call = { input: structuredClone(input), signal: Boolean(options?.signal) } as (typeof calls)[number]
  calls.push(call)
  try { return await graph(input, options) }
  catch (error) { call.error = error instanceof Error ? error.message : String(error); throw error }
}
const root = createClientUiRoot(document.getElementById('root')!)
root.render(<GlobalRecallSurface visible catalog={null} projection={null} selection={null} />)
Object.assign(window, { graphTitleProbe: {
  ready: true,
  theme: (appAppearance: 'dark' | 'light') => updateThemeSelection({ ...useAppStore.getState().config!.appearance, appAppearance }),
  calls: () => structuredClone(calls),
  facts: () => {
    const state = useAppStore.getState()
    return { notebook: state.recallNotebookId, note: state.recallNoteId, catalog,
      sessions: state.sessions.map(session => ({ id: session.id, run: session.control.run })), drafts: state.agentComposerDrafts,
      tabs: state.tabs, layouts: state.layouts, canvasLayouts: state.noteCanvasLayouts }
  }
} })
