import { type ReactNode, type Ref } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { notebookFingerprint, type NotebookActor, type NoteResource } from '@agentmux/core/notebook-catalog'
import type { FileDocument } from '../../../shared/contracts'
import { sameNoteResource } from '../lib/notebook-library'
import { useAppStore } from '../store'
import { sessionPresentationById } from '../lib/session-presentation'
import { ConversationSpeakerAvatar } from './ConversationSpeakerAvatar'

const UnknownIcon = semanticIconComponent('status.unknown')

export type NoteParticipant = { actor: NotebookActor; detail?: ReactNode }
export type NoteSavedEditor = { actor: NotebookActor; createdBlocks: number; lastEditedBlocks: number; lastAt: number }
export type NoteSavedEditors = { editors: NoteSavedEditor[]; unknown?: string }

/** Only the original File owner's out-of-band observation can identify saved editors. */
export function noteSavedEditors(document: Pick<FileDocument, 'path' | 'revision' | 'noteProvenance'>, noteId: string, resource: NoteResource | undefined): NoteSavedEditors {
  const saved = document.noteProvenance
  if (!saved || !resource || document.path !== resource.path || saved.noteId !== noteId ||
      !sameNoteResource(saved.resource, resource) || saved.revision !== document.revision) {
    return { editors: [], unknown: 'Saved block authors are not confirmed for this file and revision.' }
  }
  if (saved.status !== 'recorded') return { editors: [], unknown: `Saved block authors are unconfirmed. ${saved.reason}` }
  const authors = new Map<string, NoteSavedEditor>()
  let missing = Object.keys(saved.blocks).length === 0
  for (const block of Object.values(saved.blocks)) for (const kind of ['created', 'lastEdited'] as const) {
    const entry = block[kind]
    if (!entry) { missing = true; continue }
    const key = notebookFingerprint(entry.actor)
    const author = authors.get(key) ?? { actor: entry.actor, createdBlocks: 0, lastEditedBlocks: 0, lastAt: entry.at }
    if (kind === 'created') author.createdBlocks++
    else author.lastEditedBlocks++
    author.lastAt = Math.max(author.lastAt, entry.at); authors.set(key, author)
  }
  return { editors: [...authors.values()].sort((a, b) => b.lastAt - a.lastAt || notebookFingerprint(a.actor).localeCompare(notebookFingerprint(b.actor))),
    ...(missing ? { unknown: 'Some saved blocks have no confirmed author record.' } : {}) }
}

function Participant({ actor, self, detail, compact = false }: NoteParticipant & { self: NotebookActor | null; compact?: boolean }) {
  const isSelf = self !== null && actor.kind === self.kind && actor.id === self.id
  const agentName = useAppStore(state => actor.kind === 'agent' ? state.agentNames[actor.id] : undefined)
  const providerId = useAppStore(state => {
    const session = actor.kind === 'agent' ? sessionPresentationById(state.sessions).get(actor.id) : undefined
    return session?.kind === 'agent' ? session.providerId : undefined
  })
  const profile = useAppStore(state => isSelf && actor.kind !== 'agent' ? state.config?.profile : undefined)
  const name = actor.kind === 'agent' ? `Agent · ${agentName ?? actor.id}` : isSelf ? 'You' : actor.kind === 'device' ? `Person on device · ${actor.id}` : `Person · ${actor.id}`
  return <><ConversationSpeakerAvatar speaker={{ role: actor.kind === 'agent' ? 'agent' : 'human', id: actor.id }} name={name} size={compact ? 18 : 22}
    {...(providerId === undefined ? {} : { providerId })} humanAvatar={profile?.avatar} />
    {!compact ? <span className="note-participants__identity"><strong>{name}</strong><small><code>{actor.kind} · {actor.id}</code></small>{detail ? <small>{detail}</small> : null}</span> : null}</>
}

/** A bounded summary, never a presence or online indicator. The full roster stays reachable. */
export function NoteParticipantStack({ group, participants, unknown, self, expanded, onOpen, triggerRef }: {
  group: 'Editors' | 'Followers'; participants: readonly NoteParticipant[]; unknown?: string | undefined; self: NotebookActor | null
  expanded: boolean; onOpen: () => void; triggerRef: Ref<HTMLButtonElement>
}) {
  return <button ref={triggerRef} type="button" className="note-participants__trigger" aria-label={`Page ${group.toLowerCase()}`} aria-expanded={expanded} title={unknown}
    aria-description={unknown && !participants.length ? unknown : `${participants.length} ${group.toLowerCase()}${unknown ? ' confirmed; some authors are unknown' : ''}`} onClick={onOpen}>
    <span className="note-participants__group">{group}</span>
    {participants.length ? <span className="note-participants__stack">{participants.slice(0, 3).map(participant => <span className="note-participants__avatar" key={notebookFingerprint(participant.actor)}><Participant {...participant} self={self} compact /></span>)}
      {participants.length > 3 ? <span className="note-participants__overflow" aria-label={`${participants.length - 3} more ${group.toLowerCase()}`}>+{participants.length - 3}</span> : null}</span> : null}
    {unknown ? <UnknownIcon className="note-participants__uncertainty" size={12} /> : null}
  </button>
}

export function NoteParticipantList({ participants, self }: { participants: readonly NoteParticipant[]; self: NotebookActor | null }) {
  return <ul className="note-participants__list">{participants.map(participant => <li key={notebookFingerprint(participant.actor)} data-participant-kind={participant.actor.kind} data-participant-id={participant.actor.id}>
    <Participant {...participant} self={self} />
  </li>)}</ul>
}
