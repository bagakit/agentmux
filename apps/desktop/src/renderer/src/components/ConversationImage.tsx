import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import type { PastedImage } from '../../../shared/contracts'

/**
 * Read a pasted image (`<home>/.agentmux/pasted/…`) back as an `<img>`-ready data URI, or null when it
 * is not a readable pasted image.
 *
 * Injected rather than imported: the real implementation is an IPC call, and importing it here would put
 * a main-process dependency inside a pure prose renderer. Absent by default — a caller (see AgentMarkdown)
 * that does not pass it gets today's behaviour, a pasted path rendered as its plain-text reference. This
 * only reads bytes; whether the token is even shaped like one of our pasted images is decided purely, by
 * `splitPastedImageReferences`, before this is ever called.
 */
export type ReadPastedImage = (path: string) => Promise<PastedImage | null>

/**
 * A pasted image (`<home>/.agentmux/pasted/…`) shown as a clickable thumbnail that enlarges in a
 * lightbox — replacing the dead file-link button the user reported.
 *
 * Lives in its own file, not inside AgentMarkdown, because it answers a different question: AgentMarkdown
 * maps a node tree to elements, while this owns an overlay's whole lifecycle — a lazy byte load with three
 * end states and a Radix Dialog Portal. Keeping it here means a reader of the markdown renderer never has
 * to step over image-loading and focus-trap code to follow how prose becomes elements, and the Dialog
 * primitive is imported only where it is used.
 *
 * The `@path` token in the message text is NEVER rewritten (the Agent reads the image from it); this only
 * changes how the token is DISPLAYED. Bytes load lazily via the injected read seam. Three end states:
 *   - loading → the plain-text token (so it reads correctly until the image arrives, never a blank box)
 *   - failed  → fall back to the plain-text token, exactly what showed before this feature (a broken
 *               `<img>` is worse: the user cannot tell a bad image from a broken app)
 *   - loaded  → the thumbnail, click to enlarge
 */
export function ConversationImage({
  text,
  path,
  readPastedImage
}: {
  text: string
  path: string
  readPastedImage: ReadPastedImage
}) {
  const [image, setImage] = useState<PastedImage | null>(null)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let alive = true
    setImage(null)
    setFailed(false)
    readPastedImage(path)
      .then((result) => {
        if (!alive) return
        if (result) setImage(result)
        else setFailed(true)
      })
      .catch(() => {
        if (alive) setFailed(true)
      })
    return () => {
      alive = false
    }
  }, [path, readPastedImage])

  // Loading or unreadable → the verbatim token as plain text. This is the required fallback: the path
  // representation stays visible and the Agent's reference is never lost behind a broken image frame.
  if (failed || !image) return <>{text}</>

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button type="button" className="md-conversation-image" title={path}>
          <img className="md-conversation-image__thumb" src={image.dataUrl} alt={path} />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="md-conversation-image__overlay" />
        <Dialog.Content className="md-conversation-image__lightbox" aria-describedby={undefined}>
          {/* Radix requires a title for the dialog; it is visually hidden but read to assistive tech.
              There is no description — the enlarged image is the whole content — so describedby is
              explicitly cleared rather than left to warn about a missing Description. */}
          <Dialog.Title className="md-conversation-image__a11y">{path}</Dialog.Title>
          <img className="md-conversation-image__full" src={image.dataUrl} alt={path} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
