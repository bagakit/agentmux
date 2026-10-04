import { ComposerTextarea, TextInput } from '@agentmux/client-ui/input'
import * as Dialog from '@radix-ui/react-dialog'
import type { KnowledgeTopic, TopicKnowledge, TopicKnowledgeSource } from '@agentmux/core/control'
import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import { resolveOverlayContainer } from './WindowOverlayHost'
import { useAppStore } from '../store'
import { refreshTopicSpatial } from '../lib/topic-knowledge-actions'
import { SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'

export type KnowledgeEditTarget = { topicId: string; topicLabel?: string; entry?: TopicKnowledge; title?: string; sources?: TopicKnowledgeSource[] }
/** Target and original revision are captured at opening; save never follows later navigation. */
export function TopicKnowledgeEditor({ target, onClose, onSaved }: {
  target: KnowledgeEditTarget | null; onClose(): void; onSaved(entry: TopicKnowledge): void
}) {
  const [title, setTitle] = useState(''), [content, setContent] = useState(''), [scope, setScope] = useState('')
  const [form, setForm] = useState<TopicKnowledge['form']>('derived'), [certainty, setCertainty] = useState<TopicKnowledge['certainty']>('proposal')
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null), entryId = useRef('')
  const sources = target?.entry?.sources ?? target?.sources ?? []
  useEffect(() => {
    entryId.current = target?.entry?.entryId ?? crypto.randomUUID()
    setTitle(target?.entry?.title ?? target?.title ?? ''); setContent(target?.entry?.content ?? ''); setScope(target?.entry?.scope ?? '')
    setForm(target?.entry?.form ?? (target?.sources?.length ? 'reference' : 'derived')); setCertainty(target?.entry?.certainty ?? 'proposal'); setError(null)
  }, [target])
  async function save() {
    if (!target || busy || !title.trim()) return
    setBusy(true); setError(null)
    try {
      const result = await api.topics.call('topic.knowledge.write', { topicId: target.topicId, entryId: entryId.current, title: title.trim(), content, form, certainty,
        sources, ...(scope.trim() ? { scope: scope.trim() } : {}), expectedRevision: target.entry?.revision ?? null })
      onSaved(result.entry); onClose()
    } catch (cause) { setError(presentError(cause) + ' Your draft is kept here. Inspect the saved entry before repeating an unconfirmed save.') }
    finally { setBusy(false) }
  }
  return <Dialog.Root open={Boolean(target)} onOpenChange={open => { if (!open && !busy) onClose() }}>
    <Dialog.Portal container={resolveOverlayContainer()}><Dialog.Overlay className="confirmation-dialog__overlay dialog-scrim" />
      <Dialog.Content className="confirmation-dialog dialog-surface topic-dialog topic-knowledge-editor" onOpenAutoFocus={event => { event.preventDefault(); input.current?.focus() }}
        onEscapeKeyDown={event => { if (busy || isImeOwnedKeyboardEvent(event)) event.preventDefault() }} onInteractOutside={event => { if (busy) event.preventDefault() }}>
        <Dialog.Title className="confirmation-dialog__title">{target?.entry ? 'Edit knowledge note' : 'Create knowledge note'}</Dialog.Title>
        <Dialog.Description className="confirmation-dialog__description">{target?.topicLabel ? `In ${target.topicLabel}. ` : ''}{sources.length ? 'Keep the source references and add what you learned.' : 'Write what future discussions should be able to find.'}</Dialog.Description>
        <form onSubmit={event => { event.preventDefault(); void save() }}>
          <label>Title<TextInput ref={input} value={title} maxLength={120} disabled={busy} onChange={event => setTitle(event.target.value)} /></label>
          <div className="topic-dialog__row"><label>Form<select value={form} disabled={busy} onChange={event => setForm(event.target.value as TopicKnowledge['form'])}><option value="derived">Written knowledge</option>{sources.length ? <option value="reference">Source reference</option> : null}</select></label>
            <label>Status<select value={certainty} disabled={busy} onChange={event => setCertainty(event.target.value as TopicKnowledge['certainty'])}><option value="proposal">Proposal</option><option value="inference">Inference</option><option value="fact">Fact</option><option value="decision">Decision</option></select></label></div>
          <label>Knowledge<ComposerTextarea value={content} rows={9} disabled={busy} placeholder="What should future discussions be able to find?" onValueChange={setContent} /></label>
          <label>Applies to<TextInput value={scope} disabled={busy} placeholder="Optional context or limits" onChange={event => setScope(event.target.value)} /></label>
          {sources.length ? <details className="topic-knowledge-sources"><summary>{sources.length} original source{sources.length === 1 ? '' : 's'}</summary>{sources.map((source, index) => <p key={index}>{knowledgeSourceLabel(source)}</p>)}</details> : null}
          {error ? <p role="alert" className="surface-inline-error">{error}</p> : null}
          <footer><button type="button" className="small-button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy || !title.trim()}>{busy ? 'Saving…' : 'Save knowledge'}</button></footer>
        </form>
      </Dialog.Content></Dialog.Portal>
  </Dialog.Root>
}
export function knowledgeSourceLabel(source: TopicKnowledgeSource): string {
  return source.kind === 'file' ? source.path : source.kind === 'url' ? source.url : source.kind === 'note' ? 'Original note' : source.kind === 'notebook' ? 'Original notebook' : source.kind === 'topic' ? 'Original discussion' : source.kind === 'survey' ? 'Original research' : 'Original workface'
}
export function TopicKnowledgeCapture({ target, onClose, onSaved }: { target: { title: string; sources: TopicKnowledgeSource[] } | null; onClose(): void; onSaved?: (entry: TopicKnowledge) => void }) {
  const categories = useAppStore(state => state.topicCategories)
  const [topics, setTopics] = useState<KnowledgeTopic[]>([]), [topicId, setTopicId] = useState(''), [error, setError] = useState<string | null>(null)
  const [edit, setEdit] = useState<KnowledgeEditTarget | null>(null), [loading, setLoading] = useState(false)
  const [newTitle, setNewTitle] = useState(''), [categoryId, setCategoryId] = useState(''), [creating, setCreating] = useState(false)
  const newTopicId = useRef('')
  function destinationLabel(topic: KnowledgeTopic): string {
    const categoryNames = categories.filter(category => topic.categorySpaceIds.includes(category.spaceId)).map(category => category.title)
    const context = topics.filter(candidate => candidate.title === topic.title).length > 1 ? [topic.hostId, topic.directoryPath] : []
    return [topic.title, ...categoryNames, ...context].join(' · ')
  }
  useEffect(() => { if (!target) return; let live = true; setError(null); setTopicId(''); setTopics([]); setLoading(true)
    newTopicId.current = 'view:' + crypto.randomUUID(); setNewTitle(target.title.slice(0, 120)); setCategoryId('')
    void api.topics.call('topic.ls', {}).then(result => { if (live) { setTopics(result.topics); if (result.unavailable.length) setError(result.unavailable.map(issue => issue.message).join(' ')) } }).catch(cause => { if (live) setError(presentError(cause)) }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [target])
  async function continueCapture() {
    if (!target || creating) return
    const captured = target, capturedId = newTopicId.current
    if (topicId !== '__new_topic__') {
      const topic = topics.find(topic => topic.topicId === topicId)
      if (topic) setEdit({ ...captured, topicId, topicLabel: destinationLabel(topic) })
      return
    }
    if (!newTitle.trim()) return
    setCreating(true); setError(null)
    try {
      const result = await api.topics.call('topic.create', { topicId: capturedId, title: newTitle.trim(), ...(categoryId ? { categoryId } : {}) })
      await refreshTopicSpatial()
      await useAppStore.getState().refreshScratchTopics(SCRATCH_WORKSPACE_ID, true)
      setTopics(topics => [...topics.filter(topic => topic.topicId !== result.topic.topicId), result.topic])
      setTopicId(result.topic.topicId)
      setEdit({ ...captured, topicId: result.topic.topicId, topicLabel: result.topic.title })
    } catch (cause) { setError(presentError(cause) + ' Your source and title are kept. Continuing again uses the same Topic identity.') }
    finally { setCreating(false) }
  }
  return <><Dialog.Root open={Boolean(target) && !edit} onOpenChange={open => { if (!open && !edit && !creating) onClose() }}><Dialog.Portal container={resolveOverlayContainer()}>
    <Dialog.Overlay className="confirmation-dialog__overlay dialog-scrim" /><Dialog.Content className="confirmation-dialog dialog-surface topic-dialog"
      onEscapeKeyDown={event => { if (creating || isImeOwnedKeyboardEvent(event)) event.preventDefault() }} onInteractOutside={event => { if (creating) event.preventDefault() }}>
      <Dialog.Title className="confirmation-dialog__title">Collect sources</Dialog.Title><Dialog.Description className="confirmation-dialog__description">Create a knowledge note with references to {target?.title || 'the selected content'}. The original content stays in place.</Dialog.Description>
      <label>Destination topic<select value={topicId} disabled={creating} onChange={event => setTopicId(event.target.value)}><option value="">Choose a knowledge topic…</option><option value="__new_topic__">Create a knowledge topic…</option>{topics.map(topic => <option key={topic.topicId} value={topic.topicId}>{destinationLabel(topic)}</option>)}</select></label>
      {topicId === '__new_topic__' ? <><label>Topic title<TextInput value={newTitle} maxLength={120} disabled={creating} onChange={event => setNewTitle(event.target.value)} /></label>
        <label>Category<select value={categoryId} disabled={creating} onChange={event => setCategoryId(event.target.value)}><option value="">未分类</option>{categories.filter(category => !category.readError).map(category => <option key={category.categoryId} value={category.categoryId}>{category.title}</option>)}</select></label></> : null}
      {error ? <p role="status" className="surface-inline-error">{error}</p> : null}{loading ? <p role="status">Reading Topics…</p> : null}
      <footer><button type="button" className="small-button" disabled={creating} onClick={onClose}>Cancel</button><button type="button" className="primary-button" disabled={creating || !topicId || (topicId === '__new_topic__' && !newTitle.trim())} onClick={() => void continueCapture()}>{creating ? 'Creating…' : 'Continue'}</button></footer>
    </Dialog.Content></Dialog.Portal></Dialog.Root>
    <TopicKnowledgeEditor target={edit} onClose={() => setEdit(null)} onSaved={entry => { onSaved?.(entry); setEdit(null); onClose() }} />
  </>
}
