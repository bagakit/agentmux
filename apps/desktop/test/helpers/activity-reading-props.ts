import type { ComponentProps } from 'react'
import type { ActivityView } from '../../src/renderer/src/components/ActivityView'
import type { SessionHistoryReference } from '../../src/shared/contracts'
import { createSpeakerResolver } from '@agentmux/client-ui/conversation-speaker'

type Props = ComponentProps<typeof ActivityView>
/** Fixture parameters for the real common Activity. No component, page, cache or alternate reader. */
export function activityReadingProps({ control, visible = true, readingKey, label, onClose, returnLabel, describeSpeaker,
  ...content }: Pick<Props, 'workspaceRoot' | 'homeDir' | 'openWorkspaceFile' | 'readPastedImage' | 'openHttpLink' | 'onSelectAnnotation' | 'renderMessageActions'> & {
  control: SessionHistoryReference & { kind?: 'agent'; run?: { runId: string } }
  visible?: boolean
  readingKey?: string
  label?: string
  onClose?: (() => void) | undefined
  returnLabel?: string
  describeSpeaker?: Props['describeSpeaker']
}): Props {
  return { ...content, sessionId: control.agentSessionId, executionHostId: control.hostId, items: [], capability: 'complete-events',
    conversationReading: { reference: control, identity: readingKey ?? control.run?.runId ?? control.agentSessionId,
      enabled: visible, opened: true, ...(onClose ? { onClose } : {}), ...(returnLabel ? { returnLabel } : {}) },
    describeSpeaker: describeSpeaker ?? createSpeakerResolver({ currentSession: { id: control.agentSessionId, label: label ?? 'Original Agent' } }) }
}
