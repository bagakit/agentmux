import { useEffect, useRef, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import * as Dialog from '@radix-ui/react-dialog'
import type { PastedImage } from '../lib/pasted-images.js'
import { useClientUiPlatform } from '../platform.js'

/** App-pasted references retain their confined byte reader; native references use Core's exact-record reader. */
export type ReadPastedImage = (path: string) => Promise<PastedImage | null>

type LoadedImage = { path: string; reader: ReadPastedImage; image: PastedImage }

/** One thumbnail, decode guard and Radix lightbox for conversation images. The injected reader owns
 * authorization; bytes, failures and open state stay bound to that exact reference and reader. */
export function ConversationImage({
  text,
  path,
  label,
  readImage
}: {
  text: string
  path: string
  label?: string
  readImage: ReadPastedImage
}) {
  const platform = useClientUiPlatform()
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<LoadedImage | null>(null)
  const [failed, setFailed] = useState<LoadedImage | null>(null)
  const [readFailure, setReadFailure] = useState<{ path: string; reader: ReadPastedImage; message: string } | null>(null)
  const [open, setOpen] = useState<LoadedImage | null>(null)
  const currentImage = useRef<LoadedImage | null>(null)

  useEffect(() => {
    let alive = true
    setLoaded(null)
    setFailed(null)
    setOpen(null)
    setReadFailure(null)
    readImage(path)
      .then((result) => {
        if (!alive) return
        if (result) setLoaded({ path, reader: readImage, image: result })
        else setReadFailure({ path, reader: readImage, message: 'Image is not readable from this source.' })
      })
      .catch((error: unknown) => {
        if (alive) setReadFailure({ path, reader: readImage, message: error instanceof Error ? error.message : 'Image could not be read.' })
      })
    return () => {
      alive = false
    }
  }, [path, readImage, attempt])

  // Bind both the bytes and decode/open state to this exact read. A changed source cannot render
  // the previous image during the commit before effect cleanup, or inherit a late decode error.
  const image = loaded?.path === path && loaded.reader === readImage && failed !== loaded
    ? loaded.image : null
  currentImage.current = image ? loaded : null
  const failure = readFailure?.path === path && readFailure.reader === readImage ? readFailure.message
    : failed?.path === path && failed.reader === readImage ? 'Recorded image could not be decoded.' : null
  if (!image) return <><span className="md-conversation-image__reference">{text}</span>{failure ? <small className="md-conversation-image__failure" role="status">{failure}<button type="button" className="md-conversation-image__retry" aria-label="Retry image" title="Retry image" onClick={() => setAttempt(value => value + 1)}><RotateCcw size={12} aria-hidden="true" /></button></small> : null}</>
  const decodeFailed = () => { if (currentImage.current === loaded) setFailed(loaded) }

  return (
    <Dialog.Root open={open === loaded} onOpenChange={next => {
      if (currentImage.current === loaded) setOpen(next ? loaded : null)
    }}>
      <Dialog.Trigger asChild>
        <button type="button" className="md-conversation-image" title={label ?? path}>
          <img className="md-conversation-image__thumb" src={image.dataUrl} alt={label ?? path} onError={decodeFailed} />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal container={platform.overlayContainer() as HTMLElement}>
        <Dialog.Overlay className="md-conversation-image__overlay" />
        <Dialog.Content className="md-conversation-image__lightbox" aria-describedby={undefined}>
          {/* Radix requires a title for the dialog; it is visually hidden but read to assistive tech.
              There is no description — the enlarged image is the whole content — so describedby is
              explicitly cleared rather than left to warn about a missing Description. */}
          <Dialog.Title className="md-conversation-image__a11y">{label ?? path}</Dialog.Title>
          <img className="md-conversation-image__full" src={image.dataUrl} alt={label ?? path} onError={decodeFailed} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
