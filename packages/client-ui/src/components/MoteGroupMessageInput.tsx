import { useMemo, useRef, type ReactNode } from 'react'
import type { MoteGroupMember } from '@agentmux/core/mote/group'
import type { ComposerSuggestion } from '../lib/composer-completion.js'
import { encodeSemanticReference, parseComposerDraft } from '../lib/composer-semantic-reference.js'
import { ComposerCompletionEditor } from './ComposerCompletionEditor.js'
import { MoteGroupMemberAvatar, type RenderMoteGroupAvatar } from './MoteGroupSettings.js'
import type { MoteGroupDraft } from './MoteGroupConversation.js'
import '../styles/composer-editor.css'

const completionConfig = { command: null, skill: null, reference: '@', keywords: false } as const
const groupMention = (member: MoteGroupMember) =>
  encodeSemanticReference({ kind: 'mote', token: '', label: '@' + member.name, reference: member.moteId })

export function groupDraftRecipients(value: MoteGroupDraft): string[] {
  const confirmed = new Set(Array.isArray(value.selectedMentions) ? value.selectedMentions : [])
  const addressed = parseComposerDraft(value.body).flatMap(part =>
    'reference' in part && part.reference.kind === 'mote' && confirmed.has(part.reference.reference) ? [part.reference.reference] : [])
  return [...new Set([...value.recipientIds, ...addressed])]
}

export function groupDraftBody(body: string, clearMoteId?: string): string {
  return parseComposerDraft(body).map(part => 'text' in part ? part.text
    : part.reference.kind === 'mote' && (clearMoteId === undefined || part.reference.reference === clearMoteId) ? part.reference.label : part.raw).join('')
}

/** Styling of a published message uses original delivery IDs and unambiguous roster names. */
export function MoteGroupMessageText({ body, recipients, members }: {
  body: string; recipients: readonly string[]; members: readonly MoteGroupMember[]
}) {
  if (!recipients.length || !body.includes('@')) return body
  const counts = new Map<string, number>()
  for (const { name } of members) counts.set(name, (counts.get(name) ?? 0) + 1)
  const names = members.filter(member => recipients.includes(member.moteId) && counts.get(member.name) === 1)
    .sort((a, b) => b.name.length - a.name.length)
  const parts: ReactNode[] = []
  let offset = 0
  for (const match of body.matchAll(/(?:^|[\s，。！？、])@/gu)) {
    const at = match.index + match[0].length - 1
    const member = names.find(({ name }) => body.startsWith(name, at + 1) &&
      /[\s，。！？、,.!?;；：:]/u.test(body[at + 1 + name.length] ?? ' '))
    if (!member || at < offset) continue
    const end = at + member.name.length + 1
    parts.push(body.slice(offset, at), <mark className="mote-group__mention" key={at}>{body.slice(at, end)}</mark>)
    offset = end
  }
  return [...parts, body.slice(offset)]
}

export function MoteGroupMessageInput({ value, members, locked, onEdit, renderAvatar }: {
  value: MoteGroupDraft; members: readonly MoteGroupMember[]; locked: boolean; onEdit(value: MoteGroupDraft): void
  renderAvatar?: RenderMoteGroupAvatar | undefined
}) {
  const completing = useRef<string | undefined>(undefined)
  const references = useMemo<ComposerSuggestion[]>(() => members.map(member => ({
    id: member.moteId, text: '@' + member.name, label: member.name, description: '', group: '群成员',
    insertText: groupMention(member),
    icon: <MoteGroupMemberAvatar member={member} render={renderAvatar} size="small" />
  })), [members, renderAvatar])
  return <ComposerCompletionEditor completionConfig={completionConfig} references={references}
    value={value.body} disabled={locked} placeholder="发消息，输入 @ 点名成员…" aria-label="群消息" suggestionListLabel="点名成员"
    onKeyDown={() => {}}
    onSelectSuggestion={(_text, _kind, item) => { completing.current = item.id }}
    onSuggestionApplied={() => { completing.current = undefined }}
    onValueChange={body => {
      const confirmed = new Set(Array.isArray(value.selectedMentions) ? value.selectedMentions : [])
      if (completing.current) confirmed.add(completing.current)
      const original = parseComposerDraft(body).map(part => 'text' in part ? part.text
        : part.reference.kind === 'mote' && !confirmed.has(part.reference.reference) ? part.reference.label : part.raw).join('')
      onEdit({ ...value, body: original, selectedMentions: [...confirmed] })
    }} />
}
