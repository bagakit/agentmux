import { createRoot } from 'react-dom/client'
import { App } from '../../../src/renderer/src/App'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { api } from '../../../src/renderer/src/lib/api'
import { prepareRendererUpdate, useAppStore } from '../../../src/renderer/src/store'
import type { ExecutorDetectionInput } from '../../../src/shared/contracts'
import '../../../src/renderer/src/styles/index.css'

// The complete production App owns startup, settings, Workbench and initialize().
// Only Desktop API ports are controlled. No user's App, filesystem or Runtime is used.
const bridge = (window as any).startupProof
api.config.get = bridge.config
api.config.save = bridge.saveConfig
api.config.onChange = bridge.onConfig
api.spatial.read = bridge.readSpatial
api.spatial.commit = bridge.commitSpatial
api.spatial.retainLabels = bridge.retainLabels
api.spatial.onChange = bridge.onSpatial
api.ui.requestStorageFlush = bridge.flush
api.sessions.snapshot = async () => ({ sessions: [], timelines: {}, recoveryCandidates: [] })
if (bridge.connectionProgress) api.sessions.onEvent = bridge.onRuntime

const pending: Array<{ executorId: string; hostId: string; input: ExecutorDetectionInput; resolve(value: unknown): void; reject(error: Error): void }> = []
const calls: Array<{ executorId: string; hostId: string; input: ExecutorDetectionInput }> = []
let released = false
function detectionInput(executorId: string, hostId: string): ExecutorDetectionInput {
  const config = useAppStore.getState().config!
  const executor = config.executors[executorId]!, host = config.hosts.find(item => item.id === hostId)!
  return structuredClone({ executorId, providerId: executor.providerId, command: executor.command, host })
}
function result(input: ExecutorDetectionInput) {
  return { input, executable: input.command, availability: 'available' as const }
}
api.executors.detect = async (executorId, hostId) => {
  const input = detectionInput(executorId, hostId)
  calls.push({ executorId, hostId, input })
  if (released) return result(input)
  return await new Promise((resolve, reject) => pending.push({ executorId, hostId, input, resolve, reject })) as ReturnType<typeof result>
}

const events: unknown[] = []
for (const type of ['click', 'input', 'keydown']) document.addEventListener(type, event => {
  const target = event.target as HTMLElement
  events.push({ type, trusted: event.isTrusted, label: target.getAttribute('aria-label') || target.textContent?.trim().slice(0, 160) })
}, true)

const scene = {
  ready: true, stage: bridge.stage, events, calls,
  release() { released = true; for (const call of pending.splice(0)) call.resolve(result(call.input)) },
  fail() {
    if (bridge.stage !== 'failure-restart') throw new Error('Only the isolated failed-observation scene may inject this protocol result.')
    const captured = pending.splice(0)
    if (captured.length !== 2) throw new Error('The original two detection requests must still be pending.')
    for (const [index, call] of captured.entries()) {
      if (index === 0) call.resolve({ input: call.input, executable: call.input.command, availability: 'check-failed',
        cause: { code: 'PROOF_CHECK_FAILED', message: 'The original executable check could not finish.' } })
      else call.reject(Object.assign(new Error('PROOF_OWNER_UNAVAILABLE: The original Host observation is unavailable.'), { code: 'PROOF_OWNER_UNAVAILABLE' }))
    }
  },
  async seed() {
    if (bridge.stage !== 'control') throw new Error('A restart must only read the original persisted workface.')
    const state = useAppStore.getState(), workspace = state.config!.workspaces.find(item => item.id === 'startup-proof-workspace')!
    await state.selectWorkspace(workspace.id)
    const opened = useAppStore.getState().openLauncher({ workspaceId: workspace.id, reveal: true })
    if (!opened) throw new Error('Production openLauncher did not return its original identity.')
    const tab = useAppStore.getState().tabs[opened]!
    const left = tab.layout.activeRegionId
    const right = useAppStore.getState().splitRegion(workspace.id, tab.id, left, 'right')
    if (!right) throw new Error('Production splitRegion did not produce its Region.')
    useAppStore.getState().focusRegion(workspace.id, tab.id, left)
    useAppStore.getState().setAgentComposerDraft(left, 'Original unsent prompt survives startup checks and process restart.')
    useAppStore.getState().setAgentComposerDraft(right, 'Independent right-hand draft remains unsent.')
    await prepareRendererUpdate('quit')
    return scene.surface()
  },
  surface() {
    const state = useAppStore.getState()
    return structuredClone({ tabs: state.tabs, layouts: state.layouts, activeWorkspaceId: state.activeWorkspaceId,
      agentComposerDrafts: state.agentComposerDrafts })
  },
  state() {
    const state = useAppStore.getState()
    return { loading: state.loading, progress: state.startupProgress, agents: state.startupAgentAvailability,
      paths: state.config?.copyPathsAsAbsolute, detections: state.executorDetections, error: state.error }
  },
  async checkpoint() { await prepareRendererUpdate('quit'); return { surface: scene.surface(), config: await bridge.config(), spatial: await bridge.readSpatial() } },
  async theme(mode: 'dark' | 'light') {
    const config = await bridge.config()
    await bridge.saveConfig({ ...config, appearance: { ...config.appearance, appAppearance: mode } }, config)
  }
}
Object.assign(window, { startupScene: scene })
createRoot(document.getElementById('root')!).render(<DesktopClientUiProvider><App /></DesktopClientUiProvider>)
