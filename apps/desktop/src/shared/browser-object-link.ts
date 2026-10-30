import { formatAmuxObjectLink } from '@agentmux/core/sharing'

/** An original resource reference, separate from the actual document URL and its authority. */
export function browserObjectLink(page: { url: string; capsuleId?: string | undefined; capsuleOrigin?: string | undefined }): string | undefined {
  if (!page.capsuleId || !page.capsuleOrigin) return undefined
  try {
    if (new URL(page.url).origin !== page.capsuleOrigin) return undefined
    return formatAmuxObjectLink({ kind: 'capsule', capsuleId: page.capsuleId })
  } catch {
    // Incomplete address observation keeps the original URL usable without guessing an object.
    return undefined
  }
}
