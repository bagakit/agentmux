import { visibleSettingsSections } from '../../../src/renderer/src/components/settings/settings-modules'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { installLarkPreview } from './lark-preview'

const larkPreview = installLarkPreview()

// Supply explicit valid fixture directories before the original App initializes.
// The browser-only sample may contain logical labels, which are not durable paths.
const before = await api.config.get()
// The isolated public Preview has no connected desktop Host. These two typed
// ports supply only the connection-offer and clipboard boundary for UI input;
// they do not authorize a device or touch the user's system clipboard.
const mobileConnectionProbe = { linkReads: 0, copied: [] }
api.deviceManagement.link = async () => {
  mobileConnectionProbe.linkReads++
  return { hostId: 'preview-host', url: 'https://device.example.test/connect?offer=preview' }
}
api.ui.writeClipboardText = async value => { mobileConnectionProbe.copied.push(value) }
await api.config.save({ ...before, composerShortcuts: [
  { id:'review-changes', keyword:'review', label:'Review changes', body:'Review the changes for correctness, missed edge cases and the smallest useful improvement.' },
  { id:'explain-decision', keyword:'explain', label:'Explain this decision', body:'Explain the decision in plain language. Use one concrete example and identify the assumption that matters most.', providerId:Object.values(before.executors)[0].providerId },
  { id:'prepare-handoff', keyword:'handoff', label:'Prepare a careful handoff', body:'Describe the objective, confirmed constraints and completed changes.\n\nInclude the verification that actually ran, then list remaining decisions and their original sources.' }
], workspaces: before.workspaces.map(workspace => ({...workspace,
  path: workspace.path.startsWith('/') ? workspace.path : new URL('controlled/'+workspace.id, new URL('/', location.href)).pathname
})) }, before)
// Only this isolated presentation scenario supplies a running service observation.
// These are controlled port facts, not a live Capsule service qualification.
const conceptIntros = new URLSearchParams(location.search).get('conceptIntros') === 'true'
const conceptProbe = { calls: [], boundary: 'Controlled Capsule runtime/config ports; no service start, stop, page creation or backend persistence.' }
if (conceptIntros) {
  let capsuleConfig = { revision: 1, contentRoot: '/private/concept-intros/capsules', defaultStorageMode: 'managed', defaultMode: 'isolated', defaultTheme: 'none' }
  api.capsuleRuntime.call = async (method, params) => {
    conceptProbe.calls.push({ method, params: structuredClone(params) })
    if (method !== 'capsule.runtime.inspect') throw new Error('Capsule lifecycle is outside the introduction review')
    return { revision: 1, desired: 'running', phase: 'running', stateDirectory: '/private/concept-intros/state', socketPath: '/private/concept-intros/capsule.sock', run: { hostId: 'local', runId: 'concept-intro-controlled-run' }, runtime: null, operation: null, issue: null }
  }
  api.capsules.call = async (method, params) => {
    conceptProbe.calls.push({ method, params: structuredClone(params) })
    if (method === 'capsule.config.inspect') return { config: structuredClone(capsuleConfig) }
    if (method === 'capsule.ls') return { capsules: [], issues: [] }
    if (method === 'capsule.config.update') {
      if (params.expectedRevision !== capsuleConfig.revision) throw new Error('The original Capsule config revision must match')
      capsuleConfig = { ...capsuleConfig, ...params.changes, revision: capsuleConfig.revision + 1 }
      return { operationId: params.operationId, status: 'committed', config: structuredClone(capsuleConfig) }
    }
    throw new Error('Unexpected Capsule operation in the bounded introduction review: ' + method)
  }
}
await import('../settings-structure/entry.mjs')

const toolkitOperations = []
for (const operation of ['add','update','remove','run','action','stop']) {
  const original = api.toolkit[operation]
  api.toolkit[operation] = async (...args) => { toolkitOperations.push({ operation, args }); return original(...args) }
}

// Fixture setup uses the original Store and Preview objects; navigation under test
// still goes through trusted input into App, SettingsPanel and its original editors.
const initial = useAppStore.getState()
const agent = initial.sessions.find(session => session.kind === 'agent' && initial.config.workspaces.some(workspace =>
  workspace.hostId === session.hostId && workspace.path === session.workspacePath))
if (!agent) throw new Error('The actual Preview must provide an Agent for exact-object navigation')
if (!initial.selectSession(agent.id)) throw new Error('The original Preview Agent must open through the production Store')
window.settingsHomeProbe = {
  ...window.structureProbe,
  catalog: visibleSettingsSections('').map(({ id, title, group }) => ({ id, title, group })),
  errors: [],
  mobileConnectionProbe,
  toolkitOperations,
  larkPreview,
  conceptProbe,
  ready: true
}
window.addEventListener('error', event => window.settingsHomeProbe.errors.push(event.message))
window.addEventListener('unhandledrejection', event => window.settingsHomeProbe.errors.push(String(event.reason)))
