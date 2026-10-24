import { useRef, useState } from 'react'
import * as Dialog from './Modal.js'
import { ConversationImageViewport } from './ConversationImageViewport.js'

/** The renderer owns these exact SVG bytes. Opening only adds a viewing surface. */
export function DiagramImage({ src, alt, onError }: { src: string; alt: string; onError(): void }) {
  const trigger = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  return <Dialog.Root open={open} onOpenChange={setOpen}>
    <Dialog.Trigger asChild>
      <button ref={trigger} type="button" className="md-diagram-image" aria-label={`Enlarge ${alt}`} title="Click to enlarge diagram">
        <img className="md-diagram-image__thumb" src={src} alt={alt} onError={onError} />
      </button>
    </Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="md-conversation-image__overlay" />
      <Dialog.Content className="md-conversation-image__lightbox" aria-describedby={undefined} onCloseAutoFocus={event => {
        // A source change or hidden reading surface is not a new focus intent.
        if (!trigger.current?.isConnected || !trigger.current.getClientRects().length) event.preventDefault()
      }}>
        <ConversationImageViewport src={src} alt={alt} name={alt} onError={onError} />
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
