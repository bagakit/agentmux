import * as Dialog from '@radix-ui/react-dialog'
import type { KnowledgeTopic, TopicCategory } from '@agentmux/core/control'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { moveKnowledgeTopic, refreshTopicSpatial } from '../lib/topic-knowledge-actions'
import { useAppStore } from '../store'
import { TopicCategoryDialog } from './TopicCategoryDialog'
import { resolveOverlayContainer } from './WindowOverlayHost'

const ThemeActionCreateCategoryIcon = semanticIconComponent('action.create-category')
const ThemeActionRefreshIcon = semanticIconComponent('action.refresh')


export type TopicMoveTarget = { topicId: string; title: string }
type TopicMoveDialogProps = { target: TopicMoveTarget | null; onClose(): void; onMoved?(): void }

/** Each opening keeps its exact Topic; a late reply cannot close a newer dialog. */
export function TopicMoveDialog({ target, onClose, onMoved }: TopicMoveDialogProps) {
  return target ? <TopicMoveContent key={target.topicId} target={target} onClose={onClose} {...(onMoved ? { onMoved } : {})} /> : null
}

function TopicMoveContent({ target, onClose, onMoved }: TopicMoveDialogProps & { target: TopicMoveTarget }) {
  const categories = useAppStore(state => state.topicCategories)
  const [topic, setTopic] = useState<KnowledgeTopic | null>(null)
  const [destination, setDestination] = useState(''), [creating, setCreating] = useState(false)
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [confirmed, setConfirmed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const request = useRef(0), moving = useRef(false)

  async function reload() {
    if (moving.current) return
    const attempt = ++request.current
    setLoading(true); setConfirmed(false); setError(null)
    try {
      const [inspection] = await Promise.all([api.topics.call('topic.inspect', { topicId: target.topicId }), refreshTopicSpatial()])
      if (attempt !== request.current) return
      const fact = inspection.topic
      if (!fact || fact.topicId !== target.topicId || fact.readError || inspection.unavailable.length) {
        setError(fact?.readError || inspection.unavailable.map(issue => issue.message).join(' ') || 'This Topic could not be confirmed. Refresh to read it again.')
        return
      }
      setTopic(fact); setConfirmed(true)
    } catch (cause) {
      if (attempt === request.current) setError(presentError(cause))
    } finally { if (attempt === request.current) setLoading(false) }
  }
  useEffect(() => {
    void reload()
    return () => { request.current += 1 }
  }, [target.topicId])

  const current = categories.filter(category => topic?.categorySpaceIds.includes(category.spaceId))
  const destinations = categories.filter(category => !topic?.categorySpaceIds.includes(category.spaceId))
  const chosen = destinations.find(category => category.categoryId === destination)
  const canMove = confirmed && topic && chosen && !chosen.readError && !loading && !busy
  function categoryLabel(category: TopicCategory): string {
    return categories.filter(item => item.title === category.title).length > 1
      ? `${category.title} — ${category.hostId} · ${category.directoryPath}` : category.title
  }
  async function move() {
    if (!canMove || !topic || moving.current) return
    const attempt = request.current
    moving.current = true; setBusy(true); setError(null)
    try {
      await moveKnowledgeTopic(topic, destination)
      if (attempt !== request.current) return
      onMoved?.(); onClose()
    } catch (cause) {
      if (attempt === request.current) {
        setConfirmed(false)
        setError(`${presentError(cause)} Refresh this Topic before trying again. Your choice is kept.`)
      }
    } finally {
      moving.current = false
      if (attempt === request.current) setBusy(false)
    }
  }

  return <>
    <Dialog.Root open onOpenChange={open => { if (!open && !moving.current && !creating) onClose() }}>
      <Dialog.Portal container={resolveOverlayContainer()}><Dialog.Overlay className="confirmation-dialog__overlay dialog-scrim" />
        <Dialog.Content className="confirmation-dialog dialog-surface topic-dialog topic-move-dialog"
          onEscapeKeyDown={event => { if (moving.current || creating || isImeOwnedKeyboardEvent(event)) event.preventDefault() }}
          onInteractOutside={event => { if (moving.current || creating) event.preventDefault() }}>
          <Dialog.Title className="confirmation-dialog__title">Move to category</Dialog.Title>
          <Dialog.Description className="confirmation-dialog__description">Keep discussions and knowledge together.</Dialog.Description>
          <p className="topic-move-dialog__topic"><strong>{topic?.title ?? target.title}</strong></p>
          <p className="topic-knowledge-hint">Current category: {current.map(categoryLabel).join(' · ') || (loading ? 'Reading…' : 'Not confirmed')}</p>
          <form onSubmit={event => { event.preventDefault(); void move() }}>
            <label>Destination category<select aria-label="Destination category" value={destination} disabled={loading || busy} onChange={event => setDestination(event.target.value)}>
              <option value="">Choose a category…</option>
              {destinations.map(category => <option key={category.categoryId} value={category.categoryId} disabled={Boolean(category.readError)}>{categoryLabel(category)}{category.readError ? ' (unavailable)' : ''}</option>)}
              {destination && !chosen ? <option value={destination} disabled>Selected category unavailable</option> : null}
            </select></label>
            {loading ? <p role="status" className="topic-knowledge-hint">Reading Topic and categories…</p> : null}
            {!loading && !destinations.some(category => !category.readError) ? <p className="topic-knowledge-hint">{destinations.length ? 'No destination category is available. Refresh or create a category.' : 'Create a category to give this Topic a new home.'}</p> : null}
            <div className="topic-move-dialog__actions">
              <button type="button" className="small-button" disabled={busy || loading} onClick={() => setCreating(true)}><ThemeActionCreateCategoryIcon size={13} />New category…</button>
              <button type="button" className="small-button" aria-label="Refresh Topic and categories" disabled={busy || loading} onClick={() => void reload()}><ThemeActionRefreshIcon size={13} />Refresh</button>
            </div>
            {error ? <p role="alert" className="surface-inline-error">{error}</p> : null}
            <footer><button type="button" className="small-button" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" className="primary-button" disabled={!canMove}>{busy ? 'Moving…' : 'Move Topic'}</button></footer>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
    <TopicCategoryDialog target={creating ? 'create' : null} onClose={() => { setCreating(false); void reload() }} />
  </>
}
