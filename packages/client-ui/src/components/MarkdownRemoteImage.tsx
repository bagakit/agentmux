import { useState } from 'react'
import { semanticIconComponent } from '../theme/icons.js'
import { parseHttpLinkUrl } from '../lib/link-url.js'

const ImageReferenceIcon = semanticIconComponent('object.image')

/**
 * README images on the public web (badges, screenshots). The browser loads only an
 * HTTPS address, lazily and without a referrer; failure keeps the author's text.
 */
export function MarkdownRemoteImage({ href, alt }: { href: string; alt: string }) {
  const url = parseHttpLinkUrl(href), [failed, setFailed] = useState<string | null>(null)
  if (!url?.startsWith('https:') || failed === url) return <span className="md-image-attachment md-image-attachment--unavailable" title={href}>
    <ImageReferenceIcon size={14} /> {alt || href}</span>
  return <img className="md-remote-image" src={url} alt={alt} title={alt || undefined} loading="lazy" decoding="async" referrerPolicy="no-referrer"
    draggable={false} onError={() => setFailed(url)} />
}
