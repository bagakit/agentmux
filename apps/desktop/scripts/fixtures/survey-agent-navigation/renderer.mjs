// Reuse the established actual App/Store/PTY bridge, not a second navigation UI.
import '../space-agent-cli/entry.mjs'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore, prepareRendererUpdate } from '../../../src/renderer/src/store'
import { SCRATCH_WORKSPACE_ID } from '@agentmux/host/mote-model'
import { spatialCatalog } from '../../../src/renderer/src/lib/space-agent-control'
import { surveyInitialZoneSelection } from '../../../src/renderer/src/lib/survey-workface'

const request = window.spaceBoundary.request
// The shared older scene predates the durable manual-input port. Preserve the
// current original API arguments and typed input-key inspection in this scene.
api.sessions.inspectInput = (control, key) => request('inspect-input', control, key)
api.sessions.rejoinInputWaiting = (control, ref) => request('rejoin-input', control, ref)
api.sessions.submitPrompt = (control, prompt, operationId, binding, choice, human, note, channel, _continuation, _pmo, _dispatch, capture, images) =>
  request('submit', control, prompt, operationId, binding, choice, human, note, channel, capture, images)
const create = api.browser.create
api.browser.create = async (...args) => {
  const page = await create(...args)
  const browser = await request('browser-create', { ...page, control: { owner: 'human', agent: null, activeOperationId: null, revision: 1, inputIsolation: 'inactive' } })
  useAppStore.getState().applyBrowserEvent({ type: 'updated', browser })
  return browser
}
// This bounded Browser metadata/control port is deliberately a fixture. It does
// not establish native webpage, CDP, input shield or OS composition correctness.
api.browser.restore = async id => request('browser-read', id)
api.browser.returnControl = async (id, input) => request('browser-handoff', id, input)
api.browser.registerPresentation = async () => { throw new Error('Native webpage composition is outside this navigation fixture') }
window.navPrepare = async () => {
  const state = useAppStore.getState()
  await state.selectWorkspace('other')
  const groupId = useAppStore.getState().layouts.other.activeGroupId
  const workId = useAppStore.getState().openLauncher({ workspaceId: 'other', tabGroupId: groupId, reveal: true })
  const work = useAppStore.getState().tabs[workId]
  useAppStore.getState().focusRegion('other', work.id, work.layout.activeRegionId, 'navigation', groupId)
  const heldWork = structuredClone(useAppStore.getState().workbenchSpaceSelection)
  const created = await useAppStore.getState().createSurveyBrowser({ workspaceId: SCRATCH_WORKSPACE_ID,
    url: 'https://private-navigation.invalid/original', preparation: null, onPrepared() {} })
  const catalog = spatialCatalog(useAppStore.getState(), [])
  useAppStore.getState().setSurveyZoneSelection(surveyInitialZoneSelection(catalog, created.zone.zoneId,
    useAppStore.getState().layouts, useAppStore.getState().tabs, created.reference.displayWorkspaceId))
  useAppStore.getState().setMainSurface('survey')
  return { ...created, heldWork }
}
window.navState = () => {
  const state = useAppStore.getState()
  return { ...window.spaceState(), mainSurface: state.mainSurface, survey: state.surveyZoneSelection, agentSteerQueues: state.agentSteerQueues,
    collected: state.surveyCollectedZones, work: state.workbenchSpaceSelection,
    surveyItems: [...document.querySelectorAll('[data-survey-zone-id]')].map(node => ({ zoneId: node.dataset.surveyZoneId, text: node.textContent })),
    browserButtons: [...document.querySelectorAll('[aria-label="在右侧创建 Agent"]')].length }
}
window.navFlush = async () => { await prepareRendererUpdate(); await request('flush') }
window.navReady = true
