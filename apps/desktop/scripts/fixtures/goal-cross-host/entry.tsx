import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { SettingsPanel } from '../../../src/renderer/src/components/SettingsPanel'
import { DocumentationNavigation } from '../../../src/renderer/src/components/documentation/DocumentationNavigation'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import type { HostMessageTrustSnapshot, HostCreationTrustSnapshot, SshHostConfig } from '../../../src/shared/contracts'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import '../../../src/renderer/src/styles/index.css'

// Real settings components and controls, isolated preview facts; this cannot approve a real Host.
const config = await api.config.get()
const host: SshHostConfig = { id: 'goal-worker', kind: 'ssh', label: 'Goal worker', hostname: 'worker.invalid', runtimeId: 'worker-runtime' }
config.hosts = [{ id: 'local', kind: 'local', label: 'This computer' }, host]
useAppStore.setState({ config, loading: false })
mountThemeRuntime(window, { ...config.appearance, appAppearance: 'dark' })
let snapshot: HostMessageTrustSnapshot = {
  local: { routeHostId: 'local', authority: { runtimeId: 'supervisor-runtime', publicKey: 'preview-supervisor-key', fingerprint: '031ef2a7bc9465d8313a2e6cb4f79802dfc1a6b30479e85d53f26a7e90c4821b' }, sources: [] },
  remote: { routeHostId: host.id, authority: { runtimeId: host.runtimeId!, publicKey: 'preview-worker-key', fingerprint: '8472bcad1d35e92640fa7c8e093b2d1f6e4c7d9b108a63e295c4f7b82d6a903e' }, sources: [] }
}
api.hosts.messageTrust = async () => structuredClone(snapshot)
api.hosts.trustMessageSource = async (_host, expected, direction) => {
  const side = direction === 'outbound' ? 'remote' : 'local'
  const source = direction === 'outbound' ? expected.local.authority : expected.remote.authority
  snapshot = { ...expected, [side]: { ...expected[side], sources: [{ purpose: 'agent-message', sourceRuntimeId: source.runtimeId,
    publicKey: source.publicKey, fingerprint: source.fingerprint, targetRuntimeId: expected[side].authority.runtimeId,
    registeredAt: 1, registeredBy: { kind: 'user', id: 'preview-user' } }] } }
  return structuredClone(snapshot)
}
api.hosts.creationTrust = async (): Promise<HostCreationTrustSnapshot> => ({ source: snapshot.local.authority, target: { ...snapshot.remote, sources: [] } })
const errors: string[] = []
window.addEventListener('error', event => errors.push(String(event.error ?? event.message)))
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)))
const root = createRoot(document.getElementById('root')!)
flushSync(() => root.render(<DocumentationNavigation.Provider value={{ open() {} } as never}><DesktopClientUiProvider>
  <SettingsPanel initialSection="hosts" onClose={() => {}} navigationRequest={{ section: 'hosts', hostId: host.id }} />
</DesktopClientUiProvider></DocumentationNavigation.Provider>))
Object.assign(window, { goalHostProbe: {
  errors, appearance: (mode: 'light' | 'dark') => {
    flushSync(() => useAppStore.setState(state => ({ config: { ...state.config!, appearance: { ...state.config!.appearance, appAppearance: mode } } })))
    return updateThemeSelection({ ...useAppStore.getState().config!.appearance })
  },
  ready: () => Boolean(document.querySelector('[data-resource-editor="goal-worker"] [data-host-panel="agents"]')),
  open: () => document.querySelector<HTMLButtonElement>('[data-resource-editor="goal-worker"] [data-host-panel="agents"]')!.click(),
  scroll: () => document.querySelector('.host-message-trust')!.scrollIntoView({ block: 'start' }),
  expand: () => { document.querySelector<HTMLDetailsElement>('.host-message-trust__identities')!.open = true },
  allow: async (index: number) => {
    const row = document.querySelectorAll('.host-message-trust__direction')[index]!
    row.querySelector<HTMLInputElement>('input')!.click()
    await new Promise(resolve => setTimeout(resolve, 30))
    row.querySelector<HTMLButtonElement>('button')!.click()
    await new Promise(resolve => setTimeout(resolve, 30))
  },
  facts: () => {
    const panel = document.querySelector<HTMLElement>('.host-message-trust')!, rect = panel.getBoundingClientRect()
    return { directions: [...panel.querySelectorAll('.host-message-trust__direction')].map(row => row.textContent),
      visible: !panel.closest('[hidden], [inert]') && rect.width > 0 && rect.top >= 0 && rect.top < innerHeight - 100,
      appearance: document.documentElement.dataset.appearance,
      overflow: document.documentElement.scrollWidth > innerWidth, errors }
  }
} })
