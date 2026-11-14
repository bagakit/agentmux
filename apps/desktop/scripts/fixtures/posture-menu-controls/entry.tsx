import { createRoot } from 'react-dom/client'
import type { AgentCatalogEntry, PostureReceipt } from '@agentmux/core'
import { createWorkspaceLayout } from '@agentmux/layout'
import { GRAPHITE_THEME, mountThemeRuntime, updateObservedTheme } from '@agentmux/client-ui/theme'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { WorkspaceWorkbench } from '../../../src/renderer/src/components/WorkspaceWorkbench'
import { api } from '../../../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../../../src/renderer/src/store'
import '../../../src/renderer/src/styles/index.css'

declare const __POSTURE_PROVIDER__: AgentCatalogEntry
const provider = __POSTURE_PROVIDER__, declaration = provider.postureControl
if (!declaration) throw Error('The original Provider must declare permissions')
const config = await api.config.get()
const workspace = config.workspaces[0]!
if (!workspace.path.startsWith('/')) throw Error('The original Workspace requires an absolute path')
const original = (await api.sessions.snapshot()).sessions.find(session => session.kind === 'agent' && session.processState === 'running')
if (!original || original.kind !== 'agent') throw Error('The hosted boundary must offer an original running Agent')
const session = { ...original, providerId: provider.id, executorId: provider.id }
const requests: unknown[] = []
api.sessions.setPosture = async (control, modeId, operationId): Promise<PostureReceipt> => {
  if (JSON.stringify(control) !== JSON.stringify(session.control) || !declaration.modes.some(mode => mode.id === modeId)) {
    throw Error('Posture action used a different Session, Run, or mode')
  }
  requests.push({ control, modeId, operationId })
  const target = { hostId: control.hostId, runtimeId: 'fixture-runtime', agentSessionId: control.agentSessionId,
    expectedRun: control.run, providerId: provider.id }
  return { action: 'agent-posture', controlId: declaration.id, modeId, target, operationId, nativeOperationId: operationId,
    runtime: { runtimeId: target.runtimeId, instanceId: 'fixture-native', buildIdentity: 'fixture', protocolVersion: 1 },
    actor: { kind: 'user', id: 'fixture-user' }, phase: 'settled', outcome: 'applied', diskDurability: 'confirmed',
    acknowledgement: { runId: control.run.runId, appliedByteRange: { startByte: 0, endByte: 1 }, acceptedThroughByte: 1 }
  }
}
await useAppStore.getState().initialize()
const tabId = 'posture-tab', regionId = 'posture-region'
const tab = createWorkbenchTab(tabId, { regionId, kind: 'agent', phase: 'attached', workspaceId: workspace.id, sessionId: session.id })
useAppStore.setState({
  activeWorkspaceId: workspace.id, mainSurface: 'workbench', sessions: [session], providerCatalog: [provider],
  tabs: { [tabId]: tab }, layouts: { [workspace.id]: createWorkspaceLayout('posture-group', [tabId]) },
  viewModes: { [session.id]: 'activity' }
})
mountThemeRuntime()
Object.assign(window, { postureProof: {
  appearance: (value: 'light' | 'dark') => updateObservedTheme(GRAPHITE_THEME, value),
  facts: () => ({ requests, declaration, original: session.control, draft: useAppStore.getState().agentComposerDrafts[session.id] })
} })
createRoot(document.getElementById('root')!).render(
  <DesktopClientUiProvider><WorkspaceWorkbench workspaceId={workspace.id} /></DesktopClientUiProvider>
)
