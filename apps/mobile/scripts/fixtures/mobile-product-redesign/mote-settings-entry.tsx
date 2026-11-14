import { createRoot } from 'react-dom/client'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { ClientUiProvider } from '@agentmux/client-ui'
import * as Dialog from '@agentmux/client-ui/components/Modal'
import { GRAPHITE_THEME, mountThemeRuntime, updateObservedTheme } from '@agentmux/client-ui/theme'
import { MobileMoteProfile } from '../../../src/navigation/MobileMoteProfile'
import { MobileSheetHandle } from '../../../src/navigation/MobileSheetHandle'
import { createBrowserPlatform } from '../../../src/platform/browser'
import { getDeviceWorkface } from '../../../src/recovery/device-workface'
import '@agentmux/client-ui/styles.css'
import '../../../src/mobile.css'

const bootstrap = await fetch('/bootstrap').then(response => response.json())
const platform = createBrowserPlatform(), owner = getDeviceWorkface()
if (!owner.snapshotIdentity().host) await owner.confirmHost({ origin: location.origin, hostId: bootstrap.hostId })
mountThemeRuntime(window, { kind: 'observed', document: GRAPHITE_THEME, appearance: 'light' })
const calls: Array<{ method: string; params: unknown; draftAtDispatch?: unknown }> = []
const client = { runtimeOwnerIdentity: () => bootstrap.runtime, onEvent: () => () => {},
  async forwardRpc(method: string, params: unknown, context?: { signal?: AbortSignal }) {
    const call = { method, params: structuredClone(params), ...(method === 'space.mote.preferences.save' ? { draftAtDispatch: structuredClone(owner.snapshot().record.moteQuickDrafts?.[0]) } : {}) }
    calls.push(call)
    const response = await fetch('/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }), ...(context?.signal ? { signal: context.signal } : {}) })
    const packet = await response.json()
    if (!response.ok) throw new Error(packet.error)
    return packet.result
  }
} as unknown as AgentMuxHostedClient
const identity = { name: '协作搭档', project: '原工作', mote: { name: '协作搭档', spaceId: bootstrap.target.spaceId, facts: bootstrap.fact } }
Object.assign(window, { mobileProductScene: { facts: () => ({ record: owner.snapshot().record, recordIssue: owner.snapshot().issue, calls, appearance: document.documentElement.dataset.appearance, settingsText: document.querySelector('.mobile-mote-quick-editor')?.textContent,
  settingsOverflow: (() => { const sheet = document.querySelector<HTMLElement>('.mobile-sheet'); return !!sheet && sheet.scrollWidth > sheet.clientWidth })() }) },
  mobileSettingsTheme: (appearance: 'dark' | 'light') => updateObservedTheme(GRAPHITE_THEME, appearance),
  mobileSettingsScenario: async (change: unknown) => {
    const response = await fetch('/scenario', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(change) })
    if (!response.ok) throw Error('Private source control failed')
    return response.json()
  } })
createRoot(document.getElementById('root')!).render(<ClientUiProvider platform={platform}>
  <div className="mobile-app"><main className="mobile-main" /></div>
  <Dialog.Root open><Dialog.Portal><Dialog.Overlay className="mobile-sheet-backdrop" /><Dialog.Content className="mobile-sheet" aria-describedby={undefined}>
    <MobileSheetHandle onClose={() => {}} /><div className="mobile-sheet-title"><Dialog.Title>协作搭档</Dialog.Title></div>
    <MobileMoteProfile identity={identity} client={client} visible copyText={platform.copyText} />
  </Dialog.Content></Dialog.Portal></Dialog.Root>
</ClientUiProvider>)
