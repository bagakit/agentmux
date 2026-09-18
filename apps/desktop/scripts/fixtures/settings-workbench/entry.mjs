import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../../../src/renderer/src/App'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import '../../../src/renderer/src/styles/index.css'

// Real App and panes, with the existing public preview API; no user Runtime or config.
await useAppStore.getState().initialize()
createRoot(document.getElementById('root')).render(createElement(App))
window.settingsProbe = {
  theme(mode) {
    const { config, setConfig } = useAppStore.getState()
    setConfig({ ...config, appearance: { ...config.appearance, appAppearance: mode } })
  },
  scale() {
    const { config, providerCatalog } = useAppStore.getState()
    const executors = Object.fromEntries(providerCatalog.map(provider => [provider.id, {
      label: provider.label, providerId: provider.id, command: provider.executable,
      args: ['--model', 'fixture model'], env: { FIXTURE: 'keep=value' }, injectAgentMuxGuide: true
    }]))
    const first = providerCatalog[0]
    executors['review-second'] = { ...executors[first.id], label: 'Review executor' }
    const workspaces = Array.from({ length: 51 }, (_, index) => ({
      ...config.workspaces[0], id: `fixture-${index + 1}`, name: `Workspace ${index + 1}`, path: `/fixture/workspace-${index + 1}`
    }))
    useAppStore.setState({ config: { ...config, executors, workspaces }, activeWorkspaceId: workspaces[0].id, detectExecutors: async () => {},
      executorDetections: Object.fromEntries(Object.keys(executors).map(id => [`local\0${id}`, { state: 'ready' }])) })
    return { workspaces: workspaces.length, providers: providerCatalog.length, executors: Object.keys(executors).length }
  },
  failNextSave() {
    const save = api.config.save
    api.config.save = async () => { api.config.save = save; throw new Error('Settings could not be saved. Try again.') }
  },
  facts() {
    const { tabs, layouts, sessions, activeWorkspaceId } = useAppStore.getState()
    return JSON.stringify({ tabs, layouts, sessionIds: sessions.map(s => s.id), activeWorkspaceId })
  }
}
