import { ActivityView } from '../../../src/renderer/src/components/ActivityView'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'

export function DensityDesktop({ data }: { data: { expected: { sessionId: string } } }) {
  return <DesktopClientUiProvider><ActivityView sessionId={data.expected.sessionId} executionHostId="local" items={[]} capability="complete-events"
    describeSpeaker={speaker => ({ name: speaker.id === data.expected.sessionId ? 'Conversation review' : speaker.id,
      project: { workspaceId: 'reading-project', name: 'Reading quality', path: '' } })}
    conversationReading={{ reference: { hostId: 'local', agentSessionId: data.expected.sessionId }, identity: 'original-reading', enabled: true, opened: true }} />
  </DesktopClientUiProvider>
}
