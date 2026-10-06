import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PastedImage } from '../lib/pasted-images.js'
import type { ConversationImageReference } from '../lib/conversation-image-references.js'
import type { ReadPastedImage } from './ConversationImage.js'
import { ConversationImageViewport } from './ConversationImageViewport.js'
import { SemanticIcon } from '../theme/icons.js'

type Loaded = { path: string; reader: ReadPastedImage; image: PastedImage }

/** One open collection. Only the selected sibling adds a read, through the original reader. */
export function ConversationImageGallery({ references, initial, onInitialError }: {
  references: readonly ConversationImageReference[]; initial: Loaded; onInitialError(): void
}) {
  const [index, setIndex] = useState(() => Math.max(0, references.findIndex(reference => reference.path === initial.path)))
  const reference = references[index]!
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [failed, setFailed] = useState<Loaded | null>(null)
  const [error, setError] = useState<{ path: string; message: string } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const current = reference.path === initial.path ? initial : loaded?.path === reference.path ? loaded : null
  const latest = useRef(current); latest.current = current
  const previousButton = useRef<HTMLButtonElement>(null), nextButton = useRef<HTMLButtonElement>(null)
  const focusDirection = useRef<-1 | 1 | null>(null)
  useEffect(() => {
    let alive = true
    setLoaded(null); setError(null); setFailed(null)
    if (reference.path !== initial.path) initial.reader(reference.path).then(image => {
      if (!alive) return
      if (image) setLoaded({ path: reference.path, reader: initial.reader, image })
      else setError({ path: reference.path, message: 'Image is not readable from this source.' })
    }).catch((cause: unknown) => {
      if (alive) setError({ path: reference.path, message: cause instanceof Error ? cause.message : 'Image could not be read.' })
    })
    return () => { alive = false }
  }, [reference.path, initial, attempt])
  useLayoutEffect(() => {
    const direction = focusDirection.current
    if (!direction) return
    focusDirection.current = null
    const preferred = direction === 1 ? nextButton.current : previousButton.current
    const other = direction === 1 ? previousButton.current : nextButton.current
    const active = document.activeElement
    if (active === document.body || !active?.isConnected) (preferred?.disabled ? other : preferred)?.focus({ preventScroll: true })
  }, [index])
  const move = (direction: -1 | 1) => {
    focusDirection.current = direction
    setIndex(previous => Math.max(0, Math.min(references.length - 1, previous + direction)))
  }
  const failure = failed === current && current ? 'Recorded image could not be decoded.' : error?.path === reference.path ? error.message : null
  return <ConversationImageViewport key={reference.path} src={current && !failure ? current.image.dataUrl : undefined}
    alt={reference.label ?? reference.path} name={reference.label ?? reference.path.split(/[\\/]/u).at(-1) ?? 'Image'}
    onError={() => {
      if (!current || latest.current !== current) return
      if (current === initial) onInitialError()
      else setFailed(current)
    }}
    fallback={<div className="md-conversation-image__state" role="status">
      <span className="md-conversation-image__reference">{reference.text}</span>
      <span>{failure ?? 'Loading image…'}</span>
      {failure ? <button type="button" className="md-conversation-image__control" aria-label="Retry image" title="Retry image" onClick={event => { event.currentTarget.closest<HTMLElement>('.md-conversation-image__viewport')?.focus({ preventScroll: true }); setAttempt(value => value + 1) }}><SemanticIcon name="action.rotate-reset" size={16} aria-hidden="true" /></button> : null}
    </div>}
    {...(references.length > 1 ? { navigation: { index, count: references.length, previous: () => move(-1), next: () => move(1), previousButton, nextButton } } : {})} />
}
