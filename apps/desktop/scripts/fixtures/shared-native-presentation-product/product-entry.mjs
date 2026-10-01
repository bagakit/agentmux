import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { createWorkspaceLayout } from '@agentmux/layout'
import { App } from '../../../src/renderer/src/App'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../../../src/shared/scratch-topics'
import { scratchTopicsScope } from '../../../src/renderer/src/lib/scratch-topic-snapshots'
import '../../../src/renderer/src/styles/index.css'
Object.assign(api.browser, window.agentmux.browser)
Object.assign(api.ui, window.agentmux.ui)
const config = await api.config.get()
const workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: '/private/shared-native-product/topics', name: 'Topics', kind: 'folder' }
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
window.localStorage.setItem('agentmux.leader-topic-floating.v1', JSON.stringify({ open: false, targetTopicId: topicId, targetTabId: tab.id, railMode: 'avatars' }))
useAppStore.setState({ loading: false, initialize: async () => () => {}, config: { ...config, workspaces: [workspace] },
  activeWorkspaceId: workspace.id, mainSurface: 'workbench', tabs: { [tab.id]: tab }, sessions: [], toolsOpen: false, projectRailOpen: false,
  scratchTopicSnapshots: { [workspace.id]: { scope: scratchTopicsScope(workspace), revision: 1, topics: [topic], error: null, reading: false } },
  layouts: { [workspace.id]: createWorkspaceLayout('product-group', [tab.id]) },
  agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } })
api.browser.onEvent(event => useAppStore.getState().applyBrowserEvent(event))
window.nativeProductProof = { paintIsPageFrame:paint=>Boolean(paint&&paint[3]===255&&((paint[0]>200&&paint[1]<80&&paint[2]<100)||(paint[0]<50&&paint[1]>150&&paint[2]<100))), facts() { const state = useAppStore.getState();return {
  tabId: tab.id, regionId: surface.regionId, browserId: browser.id, layout: state.layouts[workspace.id], tabs: Object.keys(state.tabs),
  settings: !!document.querySelector('.settings-page'),

  mote: document.querySelector('[data-pmo-teams-topic-floating]')?.matches(':popover-open') ?? false,
  stages: [...document.querySelectorAll('[data-native-browser-stage="product-browser"]')].map(stage => {
    const r=stage.getBoundingClientRect(),video=stage.querySelector('video');return { connected: stage.isConnected, width:r.width, height:r.height,
      x:r.x,y:r.y, paint: (()=>{if(!video?.videoWidth)return null;const canvas=document.createElement('canvas');canvas.width=1;canvas.height=1;const ctx=canvas.getContext('2d');ctx.drawImage(video,Math.floor(video.videoWidth/2),Math.floor(video.videoHeight/2),1,1,0,0,1,1);return [...ctx.getImageData(0,0,1,1).data]})(),
      trackIds:video?.srcObject?.getTracks().map(track=>track.id), streamId:video?.srcObject?.id,
      x:r.x,y:r.y, presentationId:stage.dataset.browserPresentationId, video:!!video, stream:!!video?.srcObject,
      videoWidth:video?.videoWidth,videoHeight:video?.videoHeight, currentTime:video?.currentTime, readyState:video?.readyState }
  })
} } }
createRoot(document.getElementById('root')).render(createElement(App))
