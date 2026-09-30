import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { SettingsPanel } from '../../../src/renderer/src/components/SettingsPanel'
import { SurfaceSwitch } from '../../../src/renderer/src/components/TopRowChrome'
import { WindowUtilityBar } from '../../../src/renderer/src/components/WindowUtilityBar'
import { SettingsNavigation } from '../../../src/renderer/src/components/SettingsNavigation'
import { WindowOverlayHost } from '../../../src/renderer/src/components/WindowOverlayHost'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import '../../../src/renderer/src/styles/index.css'

const config = await api.config.get()
config.copyPathsAsAbsolute = false
useAppStore.setState({ config, mainSurface: 'workbench', sessions: [], sessionSnapshots: {} })
const events: { type: string; trusted: boolean; label: string | null; key?: string; value?: string }[] = []
const probe = { ready: false, events }
Object.assign(window, { __settingsSearchRefinement: probe })
for (const type of ['click', 'keydown', 'input']) document.addEventListener(type, (event) => {
  const element = (event.target as Element).closest('button,input')
  if (element) events.push({ type, trusted: event.isTrusted, label: element.getAttribute('aria-label') || element.textContent,
    ...(event instanceof KeyboardEvent ? { key: event.key } : {}),
    ...(element instanceof HTMLInputElement ? { value: element.value } : {}) })
}, true)

function Fixture() {
  const [open, setOpen] = useState(true)
  return <>
    <div className="app-shell app-shell--project-rail-collapsed">
      <main className="main-shell main-shell--merged" aria-label="Controlled empty workbench" />
      {open && <SettingsPanel initialSection="general" onClose={() => setOpen(false)} />}
      <footer className="window-status-bar">
        <div className="window-status-bar__surface-switch"><SurfaceSwitch onCloseSettings={() => setOpen(false)} /></div>
        <div className="window-status-bar__right"><span>Controlled status facts</span><SettingsNavigation.Provider value={{ open: () => setOpen(true) }}><WindowUtilityBar settingsOpen={open} onCloseSettings={() => setOpen(false)} /></SettingsNavigation.Provider></div>
      </footer>
    </div>
    <WindowOverlayHost />
  </>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
probe.ready = true
