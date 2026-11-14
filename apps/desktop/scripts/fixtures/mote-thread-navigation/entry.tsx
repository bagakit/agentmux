import '../mote-discussion-threads/entry'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { requestPmoTeamsTopicFloatingOpen } from '../../../src/renderer/src/lib/pmo-teams-topic-floating'

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
Object.assign(window, { moteNavigationCapture: { ready: true, ...capture, working, calls,
  longHeader() {
    ;(window as any).moteCooperationCapture.longNames(true)
    requestPmoTeamsTopicFloatingOpen({ targetTopicId: 'launcher:reviewer' })
  },
  facts: () => ({ ...capture.facts(), metadataCalls: calls })
} })
