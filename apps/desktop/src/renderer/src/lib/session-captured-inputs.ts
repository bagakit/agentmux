import type { AgentSessionUserMessage, AgentTimelineItem, AgentTimelineSnapshot } from '@agentmux/core'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'

/** One consumer's current input facts. Core deltas replace changed items; stream
 * versions also cover a published revision of the same original object. */
export function createCapturedInputSelector() {
  let previous: {
    sessionId: string | undefined; executionHostId: string | undefined
    sourceHostId: string | undefined; epoch: string | undefined
    items: AgentTimelineItem[]; versions: Array<string | undefined>; messages: AgentSessionUserMessage[]
  } | undefined
  return (sessionId: string | undefined, timeline: AgentTimelineSnapshot | undefined, executionHostId?: string): readonly AgentSessionUserMessage[] => {
    const items = timeline?.items.filter(item => item.agentSessionId === sessionId && item.kind === 'user_message') ?? []
    const positions = new Map(timeline?.stream?.positions.map(position => [position.id, position.revision]))
    const versions = items.map(item => positions.get(item.id))
    const sourceHostId = timeline?.sourceHostId, epoch = timeline?.stream?.epoch
    if (previous && previous.sessionId === sessionId && previous.executionHostId === executionHostId &&
      previous.sourceHostId === sourceHostId && previous.epoch === epoch && previous.items.length === items.length &&
      items.every((item, index) => item === previous!.items[index] && versions[index] === previous!.versions[index])) return previous.messages
    const messages = sessionId ? projectSessionUserMessages({ agentSessionId: sessionId, timeline }) : []
    previous = { sessionId, executionHostId, sourceHostId, epoch, items, versions, messages }
    return messages
  }
}
