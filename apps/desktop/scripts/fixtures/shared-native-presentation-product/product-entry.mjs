import { fixturePath as _hygiene_fixturePath } from "../../lib/fixture-values.mjs"
import { createElement } from 'react'
import { createClientUiRoot as createRoot } from '../../../test/helpers/client-ui-render'
import { createWorkspaceLayout, splitWorkbenchRegion } from '@agentmux/layout'
import { App } from '../../../src/renderer/src/App'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '@agentmux/host/mote-model'
import { spatialCatalog } from '../../../src/renderer/src/lib/space-agent-control'
import { surveyInitialZoneSelection } from '../../../src/renderer/src/lib/survey-workface'
import { scratchTopicsScope } from '../../../src/renderer/src/lib/scratch-topic-snapshots'
import { initializeMoteFloatingPreferences } from '../../../src/renderer/src/lib/pmo-teams-topic-floating'
import '../../../src/renderer/src/styles/index.css'
Object.assign(api.browser, window.agentmux.browser)
Object.assign(api.ui, window.agentmux.ui)
const fixtureOptions = new URLSearchParams(location.search)
const surveyInitial = fixtureOptions.has('survey')
const moteResponsive = fixtureOptions.has('mote-responsive')
if (new URLSearchParams(location.search).has('preview-failure')) {
 const acquire = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices)
 let fail = true
 navigator.mediaDevices.getDisplayMedia = async options => {
  if (fail) { fail = false; throw new Error('Private fixture: video source could not start') }
  return await acquire(options)
 }
}
const config = await api.config.get()
const workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: new URLSearchParams(location.search).get('workspace') ?? _hygiene_fixturePath("private/shared-native-product/topics"), name: 'Topics', kind: 'folder' }
const topicId = 'launcher:shared-native-product', directoryPath = workspace.path + '/' + scratchTopicDirectoryName(topicId)
const topic = { id: topicId, title: 'Native shared product', summary: 'One original Browser in two actual workfaces.',
  directoryPath, topicPath: directoryPath + '/topic.md', collaborators: [],
  soul: { path: directoryPath + '/SOUL.md', content: '# SOUL', version: 'private-native-product' } }
api.scratch.listTopics = async () => [topic]
api.scratch.readTopic = async () => topic
api.scratch.ensureMote = async () => topic
api.scratch.ensureTopic = async () => topic
const url = new URL('./source.html', location.href).href
const browser = await api.browser.create('product-browser', url, workspace.id)
const surface = { ...browser, kind: 'browser', regionId: 'product-region', workspaceId: workspace.id, browserId: browser.id }
const tab = { ...createWorkbenchTab('product-tab', surface), topicId }
const sessions = []
let mainReference
if (moteResponsive) {
 const prototype = (await api.sessions.snapshot()).sessions.find(session => session.kind === 'agent')
 if (!prototype) throw new Error('The split needs the original typed Agent fixture')
 const sessionId = 'original-mote-agent', regionId = 'original-mote-agent-region'
 sessions.push({ ...prototype, id: sessionId, label: 'Original Mote conversation', hostId: 'local',
   workspacePath: directoryPath, control: { kind: 'agent', hostId: 'local', agentSessionId: sessionId, run: { runId: 'original-mote-run' } } })
 tab.layout = splitWorkbenchRegion(tab.layout, surface.regionId, 'left', regionId)
 tab.layout.root.ratio = 0.64
 tab.regions[regionId] = { regionId, workspaceId: workspace.id, kind: 'agent', phase: 'attached', sessionId }
 mainReference = { hostId: 'local', sessionId, displayWorkspaceId: workspace.id, groupId: 'product-group', tabId: tab.id, regionId }
 api.moteDialogue.read = async input => ({
   main: { target: input.target, identity: { hostId: 'local', moteId: topicId }, status: 'ready',
     resource: { ...input.target.expectedResource, zoneId: input.target.zoneId, zonePath: directoryPath, path: scratchTopicDirectoryName(topicId) + '/MOTE.md' },
     documentRevision: 'sha256:' + 'a'.repeat(64), roleRevision: 'original-mote-role', current: mainReference, issue: null },
   links: [], incarnation: 'original-mote-dialogue', throughSequence: 0, next: null, coverage: 'linked-sources-only', sourceStatus: 'read', sourceIssue: null
 })
}
window.localStorage.setItem('agentmux.leader-topic-floating.v1', JSON.stringify({ open: false, targetTopicId: topicId, targetTabId: tab.id,
 railMode: 'avatars', ...(mainReference ? { reference: mainReference } : {}) }))
useAppStore.setState({ loading: false, initialize: async () => () => {}, config: { ...config, workspaces: [workspace] },
  activeWorkspaceId: workspace.id, mainSurface: surveyInitial ? 'survey' : 'workbench', tabs: { [tab.id]: tab }, sessions, toolsOpen: false, projectRailOpen: false,
  scratchTopicSnapshots: { [workspace.id]: { scope: scratchTopicsScope(workspace), revision: 1, topics: [topic], error: null, reading: false } },
  layouts: { [workspace.id]: createWorkspaceLayout('product-group', [tab.id]) },
  agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } })
if (mainReference && !useAppStore.getState().selectMainRegion(mainReference)) throw new Error('The exact original Mote Main could not be selected in Space')
await initializeMoteFloatingPreferences()
if (surveyInitial) {
 const state = useAppStore.getState(), catalog = spatialCatalog(state, [topic]), zoneId = catalog.tabs.find(value => value.tabId === tab.id).zoneId
 useAppStore.setState({ surveyCollectedZones: { [zoneId]: true }, surveyZoneSelection: surveyInitialZoneSelection(catalog, zoneId, state.layouts, state.tabs, workspace.id), surveyToolsOpen: false })
}
api.browser.onEvent(event => useAppStore.getState().applyBrowserEvent(event))
window.nativeProductProof = { paintIsPageFrame:paint=>Boolean(paint&&paint[3]===255&&((paint[0]>200&&paint[1]<80&&paint[2]<100)||(paint[0]<50&&paint[1]>150&&paint[2]<100))), facts() { const state = useAppStore.getState();return {
  tabId: tab.id, regionId: surface.regionId, browserId: browser.id, layout: state.layouts[workspace.id], tabs: Object.keys(state.tabs),
  regionLayout: state.tabs[tab.id]?.layout,
  siblingSessions: state.sessions.map(session => session.control),
  browser: (() => {
    const browser = state.tabs[tab.id]?.regions[surface.regionId]
    return browser ? { navigationId: browser.navigationId, viewport: browser.viewport } : null
  })(),
  settings: !!document.querySelector('.settings-page'),

  mote: document.querySelector('[data-pmo-teams-topic-floating]')?.matches(':popover-open') ?? false,
  stages: [...document.querySelectorAll('[data-native-browser-stage="product-browser"]')].map(stage => {
    const r=stage.getBoundingClientRect(),video=stage.querySelector('video');return { connected: stage.isConnected, width:r.width, height:r.height,
      x:r.x,y:r.y, paint: (()=>{if(!video?.videoWidth)return null;const canvas=document.createElement('canvas');canvas.width=1;canvas.height=1;const ctx=canvas.getContext('2d');ctx.drawImage(video,Math.floor(video.videoWidth/2),Math.floor(video.videoHeight/2),1,1,0,0,1,1);return [...ctx.getImageData(0,0,1,1).data]})(),
      trackIds:video?.srcObject?.getTracks().map(track=>track.id), streamId:video?.srcObject?.id,
      visible: stage.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
      presentationId:stage.dataset.browserPresentationId, video:!!video, stream:!!video?.srcObject,
      videoWidth:video?.videoWidth,videoHeight:video?.videoHeight, currentTime:video?.currentTime, readyState:video?.readyState }
  })
} } }
createRoot(document.getElementById('root')).render(createElement(App))
