import { useEffect, useMemo, useRef, useState } from 'react'
import { SemanticIcon } from '../theme/icons.js'
import * as Dialog from '@radix-ui/react-dialog'
import type { PastedImage } from '../lib/pasted-images.js'
import { useClientUiPlatform } from '../platform.js'
import { ConversationImageGallery } from './ConversationImageGallery.js'
import { useConversationImageCollection } from './ConversationImageCollection.js'
import type { ConversationImageReference } from '../lib/conversation-image-references.js'
import { useVisibleWork } from '../lib/use-visible-work.js'

/** App-pasted references retain their confined byte reader; native references use Core's exact-record reader. */
export type ReadPastedImage = (path: string) => Promise<PastedImage | null>

type LoadedImage = { attempt: number; path: string; reader: ReadPastedImage; image: PastedImage }

/** One thumbnail, decode guard and Radix lightbox for conversation images. The injected reader owns
 * authorization; bytes, failures and open state stay bound to that exact reference and reader. */
export function ConversationImage({
  active = true,
  interactive = true,
  text,
  path,
  label,
  readImage
}: {
  active?: boolean
  interactive?: boolean
  text: string
  path: string
  label?: string
  readImage: ReadPastedImage
}) {
  const dormantClose = useRef(false)
  if (!active || !interactive) dormantClose.current = true
  const platform = useClientUiPlatform()
  const viewport = useVisibleWork<HTMLSpanElement>(active && !interactive)
  const readActive = active && (interactive || viewport.visible)
  const scope = useConversationImageCollection()
  const related = scope?.readImage === readImage ? scope.references : undefined
  const references = useMemo(() => related?.some(reference => reference.path === path) ? related : [{ path, text, ...(label === undefined ? {} : { label }) }], [related, path, text, label])
  const currentReferences = useRef(references); currentReferences.current = references
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<LoadedImage | null>(null)
  const [failed, setFailed] = useState<LoadedImage | null>(null)
  const [readFailure, setReadFailure] = useState<{ path: string; reader: ReadPastedImage; message: string } | null>(null)
  const [open, setOpen] = useState<{ image: LoadedImage; references: readonly ConversationImageReference[] } | null>(null)
  const currentImage = useRef<LoadedImage | null>(null)

  useEffect(() => {
    let alive = true
    if (!readActive || loaded?.path === path && loaded.reader === readImage && loaded.attempt === attempt) return
    setLoaded(null)
    setFailed(null)
    setOpen(null)
    setReadFailure(null)
    readImage(path)
      .then((result) => {
        if (!alive) return
        if (result) setLoaded({ attempt, path, reader: readImage, image: result })
        else setReadFailure({ path, reader: readImage, message: 'Image is not readable from this source.' })
      })
      .catch((error: unknown) => {
        if (alive) setReadFailure({ path, reader: readImage, message: error instanceof Error ? error.message : 'Image could not be read.' })
      })
    return () => {
      alive = false
    }
  }, [path, readImage, attempt, readActive])
  useEffect(() => { setOpen(null) }, [references])
  useEffect(() => { if (!active || !interactive) setOpen(null) }, [active, interactive])

  // Bind both the bytes and decode/open state to this exact read. A changed source cannot render
  // the previous image during the commit before effect cleanup, or inherit a late decode error.
  const image = loaded?.path === path && loaded.reader === readImage && failed !== loaded
    ? loaded.image : null
  currentImage.current = image ? loaded : null
  const failure = readFailure?.path === path && readFailure.reader === readImage ? readFailure.message
    : failed?.path === path && failed.reader === readImage ? 'Recorded image could not be decoded.' : null
  const fallback = <><span className="md-conversation-image__reference">{text}</span>{failure ? <small className="md-conversation-image__failure" role="status">{failure}{interactive ? <button type="button" className="md-conversation-image__retry" aria-label="Retry image" title="Retry image" onClick={() => setAttempt(value => value + 1)}><SemanticIcon name="action.retry" size={12} aria-hidden="true" /></button> : null}</small> : null}</>
  const decodeFailed = () => { if (currentImage.current === loaded) setFailed(loaded) }
  if (!interactive) return <span ref={viewport.ref} style={{ display: 'inline-block', maxWidth: '100%' }}>
    {image ? <img className="md-conversation-image__thumb" src={image.dataUrl} alt={label ?? path} title={label ?? path} onError={decodeFailed} /> : fallback}
  </span>
  if (!image) return fallback

  return (
    <Dialog.Root open={active && open?.image === loaded && open.references === references} onOpenChange={next => {
      if (next && active) dormantClose.current = false
      if (currentImage.current === loaded && currentReferences.current === references) setOpen(next && loaded ? { image: loaded, references } : null)
    }}>
      <Dialog.Trigger asChild>
        <button type="button" className="md-conversation-image" title={label ?? path}>
          <img className="md-conversation-image__thumb" src={image.dataUrl} alt={label ?? path} onError={decodeFailed} />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal container={platform.overlayContainer() as HTMLElement}>
        <Dialog.Overlay className="md-conversation-image__overlay" />
        <Dialog.Content className="md-conversation-image__lightbox" aria-describedby={undefined} onCloseAutoFocus={event => { if (dormantClose.current) event.preventDefault() }}>
          {loaded ? <ConversationImageGallery references={references} initial={loaded} onInitialError={decodeFailed} /> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
