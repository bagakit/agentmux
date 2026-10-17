import { ConversationImage, useClientUiOwnerDocument, type BrowserSelectionImageInput, type ReadPastedImage } from '@agentmux/client-ui'
import { useMemo } from 'react'
import { api } from '../lib/api'

/** The original Host validates the complete saved reference. A display path is never a local route. */
export function BrowserSelectionImage({ reference, visible, interactive }: BrowserSelectionImageInput) {
  const ownerDocument = useClientUiOwnerDocument()
  const { hostId, path, mimeType, sha256, width, height } = reference
  const original = useMemo(() => Object.freeze({ hostId, path, mimeType, width, height, ...(sha256 === undefined ? {} : { sha256 }) }),
    [hostId, path, mimeType, sha256, width, height])
  const readImage = useMemo<ReadPastedImage>(() => requestedPath => original.sha256 && requestedPath === original.path
    ? api.browser.readSelectionImage(original) : Promise.resolve(null), [original, ownerDocument])
  return visible ? <ConversationImage path={original.path} text={original.path} label="Captured selection"
    readImage={readImage} active={visible} interactive={interactive} /> : <span>{original.path}</span>
}
