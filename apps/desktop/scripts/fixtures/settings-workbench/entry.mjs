import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../../../src/renderer/src/App'
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
  facts() {
    const { tabs, layouts, sessions, activeWorkspaceId } = useAppStore.getState()
    return JSON.stringify({ tabs, layouts, sessionIds: sessions.map(s => s.id), activeWorkspaceId })
  }
}
