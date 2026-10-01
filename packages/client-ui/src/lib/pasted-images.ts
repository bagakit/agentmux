export const PASTED_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'] as const
export type PastedImageExtension = (typeof PASTED_IMAGE_EXTENSIONS)[number]

/** The `<img>`-ready mime for each accepted extension. `jpg` and `jpeg` share one. */
export const PASTED_IMAGE_MIME_TYPES: Record<PastedImageExtension, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp'
}

/** A pasted screenshot is large but bounded; anything past this is a mistake, not a screenshot. The
 *  read cap equals the write cap so nothing the paste accepts is later unreadable. */
export const PASTED_IMAGE_MAX_BYTES = 16 * 1024 * 1024

/**
 * A pasted image read back from disk as an `<img>`-ready data URI. The only consumer (`ConversationImage`)
 * drops the `dataUrl` straight into an `<img src>`; no width/height (unlike a browser screenshot these are
 * not decoded in main, and the thumbnail sizes itself with CSS).
 */
export type PastedImage = {
  dataUrl: string
}
