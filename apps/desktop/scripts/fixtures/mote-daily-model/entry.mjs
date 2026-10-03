import { createElement } from 'react'
import { createClientUiRoot } from '../../../test/helpers/client-ui-render'
import { App } from '../../../src/renderer/src/App'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore, prepareRendererUpdate } from '../../../src/renderer/src/store'
import { useLauncherState } from '../../../src/renderer/src/lib/launcher-state'
import { prepareMoteCooperationDraft, readMoteMaterial } from '../../../src/renderer/src/lib/mote-cooperation'
import { prepareMoteIdeaSchedule, stageMoteIdeaFeedback } from '../../../src/renderer/src/lib/mote-idea-request'
import { CalendarScheduleControl } from '../../../src/renderer/src/components/CalendarScheduleControl'
import { documentKey } from '../../../src/renderer/src/lib/workbench-tabs'
import { SCRATCH_WORKSPACE_ID, scratchTopicLogicalPath } from '../../../src/shared/scratch-topics'
import '../../../src/renderer/src/styles/index.css'

// The model journey owns only Agent Runs. Optional shell prewarming is outside it;
// this unresolved original port does not publish a healthy shell or an opened ACK.
api.sessions = { ...api.sessions, launchTerminal: async () => new Promise(() => {}) }
const state = () => useAppStore.getState()
let initialized = false, moteId, lastSelection, lastAgent
const initialize = state().initialize
useAppStore.setState({ initialize: async () => { const dispose = await initialize(); initialized = true; return dispose } })
const root = createClientUiRoot(document.getElementById('root'))
root.render(createElement(App))
const calendarRoot = createClientUiRoot(document.getElementById('calendar'))
function reference() {
  const choice = state().workbenchSpaceSelection
  if (!choice?.groupId || !choice.tabId || !choice.regionId) throw Error('Exact original Mote presentation is unconfirmed')
  return { displayWorkspaceId: choice.workspaceId, groupId: choice.groupId, tabId: choice.tabId, regionId: choice.regionId }
}
function scope() {
  const workspace = state().config?.workspaces.find(one => one.id === SCRATCH_WORKSPACE_ID)
  const topic = state().scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]?.topics?.find(one => one.id === moteId)
  if (!workspace || !topic) throw Error('Original Mote material owner is unconfirmed')
  const rootPath = scratchTopicLogicalPath(workspace, topic)
  if (!rootPath || topic.readError) throw Error('Original Mote directory is unconfirmed')
  return { workspace, topic, rootPath }
}
function durable() {
  const s = state()
  return { tabs: s.tabs, layouts: s.layouts, workbenchSpaceSelection: s.workbenchSpaceSelection,
    drafts: s.agentComposerDrafts, notes: s.agentComposerNotes,
    launcherDrafts: useLauncherState.getState().drafts }
}
async function selectLast() {
  if (!lastSelection) throw Error('Original discussion is unconfirmed')
  state().focusRegion(lastSelection.displayWorkspaceId, lastSelection.tabId, lastSelection.regionId, 'pointer', lastSelection.groupId)
  await prepareRendererUpdate()
}
async function openOriginal(path) {
  const owner = scope(), before = reference()
  const opened = await state().openFile(path, before.groupId, undefined, owner.workspace.id)
  if (!opened) throw Error('Original Editor did not open this path')
  const selection = reference(), region = state().tabs[selection.tabId]?.regions[selection.regionId]
  if (region?.kind !== 'file' || region.path !== path || region.workspaceId !== owner.workspace.id) throw Error('Original File target changed')
  return selection
}
async function saveOriginal(path, change) {
  const owner = scope(), opened = await openOriginal(path), key = documentKey(owner.workspace.id, path)
  const before = state().documents[key]
  if (!before || state().documentIssues[key]) throw Error('Original saved document is unconfirmed')
  let content
  if (change.kind === 'replace') {
    if (!change.before || before.content.split(change.before).length !== 2) throw Error('Correction needs one exact original fact')
    content = before.content.replace(change.before, change.after)
  } else if (change.kind === 'append') content = before.content + '\n\n' + change.text + '\n'
  else throw Error('Unknown original Editor change')
  state().updateDocument(opened.tabId, content, opened.regionId)
  await state().saveDocument(opened.tabId, opened.regionId)
  if (state().dirtyDocuments[key] || state().documentIssues[key]) throw Error('Original Editor Save remains unconfirmed')
  const observed = await readMoteMaterial(owner, path)
  if (observed.result.status !== 'read' || observed.result.document.content !== content || observed.result.document.revision === before.revision)
    throw Error('Original Editor saved bytes or revision are unconfirmed')
  return { opened, before, after: observed }
}
window.modelProof = {
  facts() { return { ready: initialized && !!state().config && !state().loading, error: state().error, moteId,
    scope: moteId ? scope() : null, lastAgent, lastSelection, sessions: state().sessions, durable: durable() } },
  async createMote() {
    if (moteId) throw Error('This journey already owns its original Mote')
    const topic = await state().createScratchTopic('mote'); moteId = topic.id
    await state().openScratchTopic(moteId, undefined, { newTab: true })
    await state().refreshScratchTopics(SCRATCH_WORKSPACE_ID, true); await prepareRendererUpdate()
    lastSelection = reference()
    state().setAgentComposerDraft(lastSelection.regionId, 'Original unsent Mote question')
    return { scope: scope(), selection: lastSelection, durable: durable() }
  },
  async discuss(question, materialNames = []) {
    await selectLast()
    const owner = scope(), original = durable()
    const prepared = await prepareMoteCooperationDraft(owner, reference(), {
      question, materialPaths: materialNames.map(name => owner.rootPath + '/' + name)
    }, () => true)
    const selected = prepared.selection, beforeIds = new Set(state().sessions.map(one => one.id))
    if (state().agentComposerDrafts[selected.regionId] !== question) throw Error('Original Launcher lost the question')
    await state().launchAgent('privateCodex', question, selected.groupId, { tabId: selected.tabId, regionId: selected.regionId })
    await prepareRendererUpdate()
    const region = state().tabs[selected.tabId]?.regions[selected.regionId]
    const agent = region?.kind === 'agent' ? state().sessions.find(one => one.id === region.sessionId && one.kind === 'agent') : null
    if (!agent || beforeIds.has(agent.id)) throw Error('Original Store.launchAgent did not confirm a new Agent')
    for (const [id, draft] of Object.entries(original.drafts)) if (state().agentComposerDrafts[id] !== draft) throw Error('An original unsent question changed')
    lastSelection = selected; lastAgent = agent
    return { question, original, selection: selected, sources: prepared.sources, agent, durable: durable() }
  },
  async readMaterial(name) { return readMoteMaterial(scope(), scope().rootPath + '/' + name) },
  async correct(name, before, after) { await selectLast(); return saveOriginal(scope().rootPath + '/' + name, { kind: 'replace', before, after }) },
  async prepareCalendar(direction) {
    await selectLast()
    const owner = scope(), material = await readMoteMaterial(owner, owner.rootPath + '/cooperation-record.md')
    if (material.result.status !== 'read') throw Error('Current original material is unconfirmed')
    const prepared = await prepareMoteIdeaSchedule(owner, reference(), { direction, includeDiscussion: false }, material.result.document, () => true)
    calendarRoot.render(createElement(CalendarScheduleControl, { target: prepared.target, initialMessage: prepared.message, initialMessageContext: prepared.frozenContext }))
    await prepareRendererUpdate()
    return prepared
  },
  async acceptIdea(choice) {
    await selectLast()
    if (!lastAgent || !choice.title?.trim() || !choice.description?.trim() || !choice.criterion?.trim()) throw Error('A human-chosen real proposal is required')
    const goalId = await state().createDemand({ title: choice.title, description: choice.description,
      sessionIds: [lastAgent.id], source: 'default-topic' })
    await state().updateDemand(goalId, { alignment: { summary: choice.description,
      criteria: [{ id: 'real-output', text: choice.criterion }], openQuestions: [] } })
    const goal = state().demands[goalId]
    if (!goal?.alignment) throw Error('Original Goal alignment is unconfirmed')
    await state().confirmDemandGoal(goalId, goal.alignment.revision)
    return { goalId, agent: lastAgent, goal: state().demands[goalId] }
  },
  async feedback(comment) {
    await selectLast()
    const owner = scope(), note = await readMoteMaterial(owner, owner.rootPath + '/cooperation-record.md')
    if (note.result.status !== 'read') throw Error('Feedback requires the original note and revision')
    await stageMoteIdeaFeedback(owner, note.result.document, { vote: 'less-useful', comment }, openOriginal, () => true)
    const opened = reference(), key = documentKey(owner.workspace.id, owner.rootPath + '/SOUL.md')
    await state().saveDocument(opened.tabId, opened.regionId)
    if (state().dirtyDocuments[key] || state().documentIssues[key]) throw Error('Original feedback Save is unconfirmed')
    return { note, soul: await readMoteMaterial(owner, owner.rootPath + '/SOUL.md'), opened }
  },
  async save() { await prepareRendererUpdate(); await api.ui.requestStorageFlush(); return durable() },
  dispose() { calendarRoot.unmount(); root.unmount() }
}
