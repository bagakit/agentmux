// The maintained fixture mounts actual App/Workbench/Composer. Only external
// typed data and side effects are controlled; this is never real Run evidence.
import './entry'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../../../src/shared/scratch-topics'
import { requestPmoTeamsTopicFloatingOpen, requestPmoTeamsTopicFloatingClose } from '../../../src/renderer/src/lib/pmo-teams-topic-floating'
import { customMoteId, defaultTab, neighborTab, customTab, ordinaryTab, neighborAgent, quietMoteId } from '../../../test/fixtures/mote-workface'

const fileCalls: unknown[] = []
const directory = (id: string) => scratchTopicDirectoryName(id)
api.files.readDirectory = async (workspaceId, path) => {
  fileCalls.push({ operation: 'readDirectory', workspaceId, path })
  const roots = [PMO_TEAMS_TOPIC_ID, customMoteId, quietMoteId]
  const row = (name: string, isDirectory = false) => ({ name, path: path ? path + '/' + name : name, isDirectory, isSymlink: false })
  if (!path) return roots.map(id => row(directory(id), true))
  if (roots.some(id => directory(id) === path)) return [row('SOUL.md'), row('topic.md'), row('notes', true)]
  return [row('research.md'), row('next-step.md')]
}
api.files.read = async (workspaceId, path) => {
  fileCalls.push({ operation: 'read', workspaceId, path })
  return { status: 'read', document: { path, content: '# Original Mote materials\n\nThis preview reads the selected resource only.\n', revision: 'fixture-revision' } }
}
useAppStore.setState(state => ({
  projectRailOpen: true,
  timelines: { ...state.timelines, [neighborAgent.id]: { agentSessionId: neighborAgent.id, revision: 1,
    items: [{ id: 'neighbor-request', agentSessionId: neighborAgent.id, kind: 'user_message', content: 'Continue the second goal in its own Session.', title: 'Continue the second goal', source: 'native-hook', status: 'complete', createdAt: 1000, updatedAt: 1000 },
      { id: 'neighbor-reply', agentSessionId: neighborAgent.id, kind: 'assistant_message', content: 'This discussion stays separate. The other goal and its draft are retained.', title: 'A separate discussion', source: 'native-hook', status: 'complete', createdAt: 2000, updatedAt: 2000 }] } },
  agentComposerDrafts: { ...state.agentComposerDrafts, [neighborAgent.id]: 'Second Session unsent draft' },
  viewModes: { ...state.viewModes, [neighborAgent.id]: 'activity' }
}))
const choose = async (topicId: string, tabId?: string) => {
  requestPmoTeamsTopicFloatingClose({ restoreFocus: false })
  await useAppStore.getState().openScratchTopic(topicId, SCRATCH_WORKSPACE_ID, tabId ? { tabId } : undefined)
}
Object.assign(window, { moteChatPreview: {
  boundary: 'Actual Renderer, controlled external facts. No live Runtime/Run or native surface claim.',
  space: () => choose(PMO_TEAMS_TOPIC_ID, defaultTab.id),
  secondSession: () => choose(PMO_TEAMS_TOPIC_ID, neighborTab.id),
  custom: () => choose(customMoteId, customTab.id),
  topic: () => choose(ordinaryTab.topicId!, ordinaryTab.id),
  empty: () => choose(quietMoteId),
  floating: () => requestPmoTeamsTopicFloatingOpen({ targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: defaultTab.id }),
  facts: () => ({ ...window.motePresentationReview.facts(), fileCalls: structuredClone(fileCalls),
    workfaces: [...document.querySelectorAll('[data-mote-workface]')].map(node => ({ topicId: node.getAttribute('data-mote-workface'),
      tabs: [...node.querySelectorAll('button.workbench-tab')].map(tab => tab.getAttribute('data-workbench-tab-id')) })) })
} })
await choose(PMO_TEAMS_TOPIC_ID, defaultTab.id)
