import { useEffect, useState } from 'react'
import { commitAuthorInitials } from './commit-presentation'

const RETRY_AFTER = 5 * 60_000
const RECHECK_AFTER = 24 * 60 * 60_000
// Only rebuildable presentation hints. Chromium's HTTP disk cache owns the image bytes.
const images = new Map<string, { expires: number; result: Promise<boolean> }>()

function avatarUrl(email: string): string | null {
  // This is the original Git %ae field, never an address guessed from the display name.
  if (!email || !/^[^\s<>@]+@[^\s<>@]+$/u.test(email)) return null
  const url = new URL('https://avatars.githubusercontent.com/u/e')
  url.searchParams.set('email', email)
  url.searchParams.set('s', '64')
  return url.href
}

function loadAvatar(url: string): Promise<boolean> {
  const cached = images.get(url)
  if (cached && cached.expires > Date.now()) return cached.result
  // An in-flight entry coalesces concurrent readers; settled failures get a short negative cache.
  const entry = { expires: Date.now() + RETRY_AFTER, result: Promise.resolve(false) }
  entry.result = new Promise<boolean>(resolve => {
    const image = new Image()
    image.referrerPolicy = 'no-referrer'
    image.crossOrigin = 'anonymous'
    const finish = (ok: boolean) => {
      entry.expires = Date.now() + (ok ? RECHECK_AFTER : RETRY_AFTER)
      image.onload = image.onerror = null
      resolve(ok)
    }
    image.onload = () => finish(true)
    image.onerror = () => finish(false)
    image.src = url
  })
  images.delete(url)
  images.set(url, entry)
  // Eviction affects only optional image reuse, never Git content or author metadata.
  if (images.size > 128) images.delete(images.keys().next().value!)
  return entry.result
}

/** Optional photo lookup cannot delay, replace or authenticate the original commit content. */
export function GitAuthorAvatar({ author, email }: { author: string; email: string }) {
  const url = avatarUrl(email)
  const [loaded, setLoaded] = useState<string | null>(null)
  useEffect(() => {
    if (!url) return
    let current = true
    void loadAvatar(url).then(ok => { if (current) setLoaded(ok ? url : null) })
    return () => { current = false }
  }, [url])
  const remote = url !== null && loaded === url
  return <span className="git-workbench__author-initials" role="img"
    aria-label={remote ? 'GitHub author avatar, not a verified identity' : 'Local author initials, not a verified photo or identity'}
    title={remote ? 'GitHub avatar for the recorded author email; may be generated, not a verified identity' : 'Generated locally from the recorded author name; not a verified photo or identity'}>
    {remote ? <img src={url} alt="" width={26} height={26} referrerPolicy="no-referrer" crossOrigin="anonymous"
      onError={() => {
        images.set(url, { expires: Date.now() + RETRY_AFTER, result: Promise.resolve(false) })
        setLoaded(null)
      }} /> : commitAuthorInitials(author)}
  </span>
}
