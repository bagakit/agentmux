import { formatAmuxObjectLink, parseAmuxObjectLink } from '@agentmux/core/sharing'

/** An original resource reference, separate from the actual document URL and its authority. */
export function browserObjectLink(page: { url: string; capsuleObjectLink?: string | undefined; capsuleId?: string | undefined; capsuleOrigin?: string | undefined; capsuleRemote?: import('./contracts.js').CapsuleRemoteSource | undefined }): string | undefined {
  if (!page.capsuleId || !page.capsuleOrigin) return undefined
  try {
    if (new URL(page.url).origin !== page.capsuleOrigin) return undefined
    if (page.capsuleRemote) {
      if (typeof page.capsuleObjectLink !== 'string') return undefined
      const target = parseAmuxObjectLink(page.capsuleObjectLink)
      return target.kind === 'host' && target.runtimeId === page.capsuleRemote.runtimeId &&
        target.resource?.kind === 'capsule' && target.resource.capsuleId === page.capsuleId
        ? formatAmuxObjectLink(target) : undefined
    }
    return formatAmuxObjectLink({ kind: 'capsule', capsuleId: page.capsuleId })
  } catch {
    // Incomplete address observation keeps the original URL usable without guessing an object.
    return undefined
  }
}
