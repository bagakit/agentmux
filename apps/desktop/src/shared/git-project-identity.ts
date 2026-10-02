/** A configured repository source, not a new Project or execution identity. */
export function normalizeGitProjectRemote(remote: string): string | null {
  const value = remote.trim()
  if (!value || /[\0\r\n]/u.test(value) || /^[a-zA-Z]:[\\/]/u.test(value) || /^[a-zA-Z][\w+.-]*::/u.test(value)) return null
  // URL parsing removes dot segments. Reject them before parsing rather than
  // asserting that a remote-relative path names the same configured source.
  if (/(?:^|[:/])(?:\.|%2e){1,2}(?:\/|[?#]|$)/iu.test(value)) return null
  let url: URL
  try {
    if (value.includes('://')) url = new URL(value)
    else {
      // Git's scp form has no slash before the first colon. Local paths must
      // never link two independent machines merely because their text matches.
      const scp = /^(?:[^/@:\s]+@)?(\[[^\]]+\]|[^/:\s]+):(.+)$/u.exec(value)
      if (!scp) return null
      url = new URL(`ssh://${scp[1]}/${scp[2]!.replace(/^\/+/, '')}`)
    }
  } catch { return null }
  const defaults: Record<string, string> = { 'https:': '443', 'http:': '80', 'ssh:': '22', 'git:': '9418' }
  if (!(url.protocol in defaults) || !url.hostname || url.search || url.hash) return null
  const path = url.pathname.replace(/^\/+|\/+$/gu, '').replace(/\.git$/u, '')
  // Tilde expansion and ambiguous path segments need the remote's own facts;
  // this read never connects to it and therefore cannot confirm those aliases.
  if (!path || path.startsWith('~') || /(^|\/)\.{1,2}(\/|$)/u.test(path)) return null
  const port = url.port && url.port !== defaults[url.protocol] ? `:${url.port}` : ''
  return `${url.hostname.toLowerCase()}${port}/${path}`
}
