import type { AgentSessionHistoryPage, AgentProviderSessionHistoryPage } from '@agentmux/core'
import { projectConversationRecords, type AgentConversationRecord } from '@agentmux/core/conversation'
import { parseAgentMuxMessagePrefix } from '@agentmux/core/agent-message-render'
import { sessionUserMessageText } from '@agentmux/core/session-user-messages'

export type LauncherRecap = { text: string; displayText?: string; reading?: { text: string; truncated: boolean }; source: 'Last assistant message' | 'Last prompt' | 'Last reply observation' | 'Saved conversation excerpt'; origin: 'timeline' | 'native' }

const RECAP_EXCERPT_LENGTH = 800

/** Keep source line boundaries for the shared Markdown grammar. This is the
 * same compact excerpt budget, not a limit on the original reading. */
export function launcherRecapExcerpt(recap: LauncherRecap): string {
  const source = recap.reading?.text ?? recap.displayText ?? recap.text
  return source.length > RECAP_EXCERPT_LENGTH ? `${source.slice(0, RECAP_EXCERPT_LENGTH - 1).trimEnd()}…` : source
}

function excerpt(text: string | undefined): Pick<LauncherRecap, 'text' | 'displayText' | 'reading'> | null {
  const value = text?.replace(/\s+/gu, ' ').trim()
  if (!value) return null
  const clamp = (body: string) => body.length > RECAP_EXCERPT_LENGTH ? `${body.slice(0, RECAP_EXCERPT_LENGTH - 1).trimEnd()}…` : body
  // Interpret complete reading wrappers before flattening; declarations prove no author.
  const parsedBody = parseAgentMuxMessagePrefix(text!)?.body.trim()
  const reading = parsedBody || text!.trim()
  const body = reading.replace(/\s+/gu, ' ').trim()
  return { text: clamp(value), ...(body && body !== value ? { displayText: clamp(body) } : {}),
    reading: { text: reading, truncated: false } }
}

/** A recap is a labelled excerpt of observed conversation, never an invented summary. */
export function launcherTimelineRecap(records: readonly Pick<AgentConversationRecord, 'role' | 'author' | 'content'>[]): LauncherRecap | null {
  const latestFirst = [...records].reverse()
  const replies = latestFirst.filter(record => record.role === 'observation' || record.role === 'message' && record.author?.kind === 'agent')
  for (const record of replies.length ? replies : latestFirst) {
    if (record.role !== 'message' && record.role !== 'observation') continue
    const text = excerpt(record.content)
    if (text) return { ...text, source: record.role === 'observation' ? 'Last reply observation'
      : record.author?.kind === 'agent' ? 'Last assistant message' : 'Last prompt', origin: 'timeline' }
  }
  return null
}

export function launcherNativeRecap(page: AgentSessionHistoryPage): LauncherRecap | null {
  const records = projectConversationRecords({ agentSessionId: page.agentSessionId, historyPage: page })
  for (const record of [...records].reverse()) {
    if (record.role !== 'message' && record.role !== 'interaction') continue
    const text = excerpt(record.input ? sessionUserMessageText(record.input.contentParts, record.input.questionAnswers) : record.content)
    if (text) return { ...text, source: record.author?.kind === 'agent' ? 'Last assistant message' : 'Last prompt', origin: 'native' }
  }
  return null
}

/** Unregistered Provider history has no Core Session, author or unified event identity. */
export function launcherSavedNativeRecap(page: AgentProviderSessionHistoryPage): LauncherRecap | null {
  for (const item of [...page.items].reverse()) {
    const text = excerpt(sessionUserMessageText(item.contentParts, item.questionAnswers))
    if (text) return { ...text, source: 'Saved conversation excerpt', origin: 'native' }
  }
  return null
}
