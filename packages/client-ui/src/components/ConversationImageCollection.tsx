import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { ConversationImageReference } from '../lib/conversation-image-references.js'
import type { ReadPastedImage } from './ConversationImage.js'

const ImageCollection = createContext<{ references: readonly ConversationImageReference[]; readImage: ReadPastedImage | undefined } | null>(null)

/** Explicit same-content presentation input, with no discovery, byte cache or persistent state. */
export function ConversationImageCollection({ references, readImage, children }: {
  references: readonly ConversationImageReference[]; readImage: ReadPastedImage | undefined; children: ReactNode
}) {
  // Streaming prose and draft edits may recreate equal arrays. Keep an open view bound to the
  // actual collection and reader, rather than the caller's array allocation.
  const referenceKey = JSON.stringify(references)
  const value = useMemo(() => ({ references, readImage }), [referenceKey, readImage])
  return <ImageCollection.Provider value={value}>{children}</ImageCollection.Provider>
}

export function useConversationImageCollection() { return useContext(ImageCollection) }
