import '../mote-discussion-threads/entry'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { requestPmoTeamsTopicFloatingOpen } from '../../../src/renderer/src/lib/pmo-teams-topic-floating'
import { directoryIdentity, homeZoneId } from '../../../src/shared/space-addresses'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicLogicalPath } from '@agentmux/host/mote-model'
import { moteMembers } from '../../../src/renderer/src/lib/mote-team'
import { workbenchSelectionCatalog } from '../../../src/renderer/src/lib/desktop-focus-navigation'
import { moteEntryDraftKey } from '../../../src/renderer/src/lib/mote-entry-hold'
import { useLauncherState } from '../../../src/renderer/src/lib/launcher-state'
import { desktopUserFragments } from '../../../src/renderer/src/lib/desktop-user-state'

const calls: unknown[] = [], owner = { hostId: 'local', runtimeId: 'original-chat-owner' }
api.connections.hostingTarget = async () => owner
api.moteChat.call = async (method, input) => {
  calls.push({ method, input })
  if (method === 'space.mote.chat.inspect') return { configuration: null, operation: null } as never
  if (method === 'space.mote.chat.audience') return { people: [], next: null } as never
  if (method === 'space.mote.chat.history') return { generations: [], next: null } as never
  throw Error('Read-only navigation fixture: ' + method)
}
function working() {
  useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === 'mote-neighbor' && session.kind === 'agent' ? {
    ...session, pendingInteraction: undefined, currentActivity: undefined,
    status: { state: 'working', source: 'native-hook', observedAt: Date.now() },
    semanticStatus: { state: 'working', source: 'native-hook', observedAt: Date.now(), stateEnteredAt: Date.now() }
  } : session) }))
}
working()
const capture = (window as any).moteDiscussionCapture
function mainDraft() {
  const state = useAppStore.getState(), workspace = state.config!.workspaces.find(value => value.id === SCRATCH_WORKSPACE_ID)!
  const topic = state.scratchTopicSnapshots[workspace.id]!.topics!.find(value => value.id === PMO_TEAMS_TOPIC_ID)!
  const rootPath = scratchTopicLogicalPath(workspace, topic)
  if (!rootPath) throw Error('The original Main draft scope must be confirmed')
  const key = moteEntryDraftKey({ workspace, topic, rootPath })
  const saved = JSON.parse(desktopUserFragments.read('launcher') ?? 'null')
  return { key, prompt: useLauncherState.getState().drafts[key]?.prompt, savedPrompt: saved?.state.drafts[key]?.prompt }
}
Object.assign(window, { moteNavigationCapture: { ready: true, ...capture, working, calls,
  reassignOriginalWorker() {
    capture.restore(); working()
    const state = useAppStore.getState(), workspace = state.config!.workspaces.find(value => value.id === SCRATCH_WORKSPACE_ID)!
    const topic = state.scratchTopicSnapshots[workspace.id]!.topics!.find(value => value.id === 'launcher:reviewer')!
    const spaceId = directoryIdentity(workspace.hostId, topic.directoryPath)
    const original = state.tabs['mote-neighbor-tab']!
    useAppStore.setState({ tabs: { ...state.tabs, [original.id]: { ...original, topicId: topic.id, space: { spaceId, zoneId: homeZoneId(spaceId) } } } })
    requestPmoTeamsTopicFloatingOpen({ targetTopicId: 'launcher:leader' })
    const catalog = workbenchSelectionCatalog(useAppStore.getState())
    return { moved: moteMembers(catalog, spaceId).some(member => member.agentSessionId === 'mote-neighbor'),
      originalTabId: original.id, originalRegionId: original.layout.activeRegionId }
  },
  longHeader() {
    ;(window as any).moteCooperationCapture.longNames(true)
    requestPmoTeamsTopicFloatingOpen({ targetTopicId: 'launcher:reviewer' })
  },
  facts: () => ({ ...capture.facts(), metadataCalls: calls, mainDraft: mainDraft() })
} })
