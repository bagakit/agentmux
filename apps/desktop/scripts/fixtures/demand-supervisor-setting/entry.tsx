import { createClientUiRoot } from '../../../test/helpers/client-ui-render'
import { SettingsPanel } from '../../../src/renderer/src/components/SettingsPanel'
import { WindowOverlayHost } from '../../../src/renderer/src/components/WindowOverlayHost'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { applyAppAppearance } from '../../../src/renderer/src/lib/app-appearance'
import '../../../src/renderer/src/styles/index.css'

const config = await api.config.get()
useAppStore.setState({ config, sessions: [], sessionSnapshots: {} })
api.config.onChange(config => useAppStore.setState({ config }))
createClientUiRoot(document.getElementById('root')!).render(<>
  <div className="app-shell app-shell--project-rail-collapsed">
    <main className="main-shell main-shell--merged" aria-label="Private empty workbench" />
    <SettingsPanel initialSection="goals" onClose={() => {}} />
    <footer className="window-status-bar"><span>Private Settings proof</span></footer>
  </div><WindowOverlayHost />
</>)
let disposeAppearance = () => {}
Object.assign(window, { settingsProbe: { theme(mode: 'light' | 'dark') {
  disposeAppearance(); disposeAppearance = applyAppAppearance(mode)
} } })
