import type { MoteThreadView } from '@agentmux/client-ui/components/MoteConversationThreads'
import '../styles/mote-thread-navigation.css'

/** Read coverage, never an unread or running-task count. Null means no confirmed count. */
export type MoteThreadCount = { value: number | null; more?: boolean; unavailable?: boolean }
export type MoteThreadCounts = Record<MoteThreadView, MoteThreadCount>
export type MoteWorkingMember = { hostId: string; agentSessionId: string; title: string }
export const emptyMoteThreadCounts = (): MoteThreadCounts => ({ work: { value: null }, private: { value: null }, members: { value: null } })
const names = { work: '工作', private: '私聊', members: '成员' }
export function moteThreadOptions(counts: MoteThreadCounts) {
  return (['work', 'private', 'members'] as const).map(view => {
    const count = counts[view]
    const coverage = count.value === null ? '数量尚未确认' : `${count.more ? '至少 ' : ''}${count.value} ${view === 'members' ? '位成员' : view === 'private' ? '段原私聊' : '项关联工作'}`
    const description = coverage + (count.unavailable ? '；当前来源暂不可用，保留已确认数量' : count.more ? '；仍有未载入来源' : '')
    return { value: view, ariaLabel: names[view], ariaDescription: description, label: <span className="mote-thread-label" title={description}>{names[view]}<span className="mote-thread-count" data-zero={count.value === 0 || undefined} aria-hidden="true">{count.value === null ? '·' : `${count.value}${count.more ? '+' : ''}`}</span></span> }
  })
}
