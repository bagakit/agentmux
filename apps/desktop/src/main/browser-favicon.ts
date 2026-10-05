import type { Session } from 'electron'

// These limits apply only to optional chrome artwork, never to page navigation or Agent work.
export const BROWSER_FAVICON_MAX_BYTES = 128 * 1024
export const BROWSER_FAVICON_TIMEOUT_MS = 2500
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon'])

/** Read the page's reported icon with its own cookie/profile session, without remote Renderer images. */
export async function readBrowserFavicon(session: Pick<Session, 'fetch'>, url: string, signal: AbortSignal): Promise<string | undefined> {
  const controller = new AbortController()
  const cancel = () => controller.abort()
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) controller.abort()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const timer = setTimeout(cancel, BROWSER_FAVICON_TIMEOUT_MS)
  let rejectAborted!: () => void
  const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = () => reject(new Error('Favicon observation ended')) })
  controller.signal.addEventListener('abort', rejectAborted, { once: true })
  try {
    if (controller.signal.aborted || url.length > BROWSER_FAVICON_MAX_BYTES * 2 || !['https:', 'http:', 'data:'].includes(new URL(url).protocol)) return
    return await Promise.race([aborted, (async () => {
      const response = await session.fetch(url, { signal: controller.signal, credentials: 'include' })
      const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
      const length = Number(response.headers.get('content-length'))
      if (!response.ok || !type || !imageTypes.has(type) || length > BROWSER_FAVICON_MAX_BYTES || !response.body) return
      reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let bytes = 0
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > BROWSER_FAVICON_MAX_BYTES) return
        chunks.push(chunk.value)
      }
      if (!bytes || controller.signal.aborted) return
      return `data:${type};base64,${Buffer.concat(chunks).toString('base64')}`
    })()])
  } catch {
    // Missing, invalid or slow artwork leaves the original Browser fully usable with its type glyph.
    return
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', cancel)
    controller.signal.removeEventListener('abort', rejectAborted)
    controller.abort()
    if (reader) void reader.cancel().catch(() => {})
  }
}
