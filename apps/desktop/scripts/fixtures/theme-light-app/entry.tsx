import { fixturePath as _reshape_fixturePath } from "../../../../../test/fixture-values.mjs"
import { createRoot } from 'react-dom/client'
import { App } from '../../../src/renderer/src/App'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import '../../../src/renderer/src/styles/index.css'
const ownerMode = new URL(location.href).searchParams.has('owner')
if (ownerMode) {
  const listeners = new Set<(value: Awaited<ReturnType<typeof api.config.get>>) => void>()
  api.config.get = async () => { const response = await fetch('/proof-config'); if (!response.ok) throw Error(await response.text()); return response.json() }
  api.config.save = async (next, expected) => {
    const response = await fetch('/proof-config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ next, expected }) })
    if (!response.ok) throw Error(await response.text())
    const saved = await response.json(); listeners.forEach(listener => listener(saved)); return saved
  }
  api.config.onChange = listener => { listeners.add(listener); return () => { listeners.delete(listener) } }
} else {
  const original = await api.config.get()
  await api.config.save({ ...original, workspaces: original.workspaces.map((item,index)=>({...item,path:_reshape_fixturePath(`private/theme-light-workspace-${index}`)})), appearance: { ...original.appearance, appAppearance: 'dark', themeId: 'graphite' } }, original)
}
const originalSnapshot = api.sessions.snapshot
api.sessions.snapshot = async () => { const snapshot = await originalSnapshot(); return { ...snapshot, config: await api.config.get(), sessions: snapshot.sessions.map(item => ({ ...item, workspacePath: item.workspacePath.startsWith('/') ? item.workspacePath : _reshape_fixturePath("private/theme-light-original-session") })) } }
createRoot(document.getElementById('root')!).render(<DesktopClientUiProvider><App /></DesktopClientUiProvider>)
Object.assign(window, { lightProof: {
  async setMode(appAppearance: 'dark' | 'light') { const previous = useAppStore.getState().config!; const config = await api.config.save({ ...previous, appearance: { ...previous.appearance, appAppearance } }, previous); useAppStore.setState({ config }) },
  facts() { return { mode: document.documentElement.dataset.appearance, config: useAppStore.getState().config?.appearance, loading: useAppStore.getState().loading } }
} })
