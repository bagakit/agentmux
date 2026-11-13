/** Content is inert even when an upstream adapter preserves active HTML markup. Host reader frames add their own sandbox. */
export const BOOK_CONTENT_CSP = "default-src 'none'; script-src 'none'; connect-src 'none'; img-src blob: data:; style-src 'unsafe-inline' blob:; font-src blob: data:; media-src blob: data:; base-uri 'none'; form-action 'none'"

const external = (value: string): boolean => /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value.trim().replace(/[\u0000-\u0020]/g, '')) && !/^(?:blob:|data:|filepos:|kindle:)/i.test(value.trim().replace(/[\u0000-\u0020]/g, ''))

export function sanitizeBookDocument(doc: Document): void {
  for (const element of doc.querySelectorAll('script, iframe, frame, object, embed, base, form, input, button, textarea, select, meta[http-equiv], foreignObject')) element.remove()
  for (const element of doc.querySelectorAll('*')) {
    for (const { name, value } of [...element.attributes]) {
      if (/^on/i.test(name) || name === 'srcdoc' || /^(?:javascript|vbscript):/i.test(value.trim().replace(/[\u0000-\u0020]/g, ''))) element.removeAttribute(name)
      else if (['src', 'href', 'xlink:href', 'poster', 'data', 'action'].includes(name) && external(value)) element.removeAttribute(name)
      else if (name === 'srcset' && /(?:https?:|\/\/)/i.test(value)) element.removeAttribute(name)
    }
  }
  const policy = doc.createElementNS('http://www.w3.org/1999/xhtml', 'meta')
  policy.setAttribute('http-equiv', 'Content-Security-Policy')
  policy.setAttribute('content', BOOK_CONTENT_CSP)
  const head = doc.head ?? doc.getElementsByTagName('head')[0]
  head?.prepend(policy)
}

/** ZIP entry names are archive-relative protocol paths, never host paths. */
export function archivePath(path: string): string {
  if (!path || path.startsWith('/') || path.includes('\\') || /^[a-z][a-z\d+.-]*:/i.test(path)
    || path.split('/').some(part => part === '..' || part === '.' || part === '') || /[\u0000-\u001f]/.test(path)) {
    throw Object.assign(new Error('The book archive contains an invalid resource path'), { code: 'BOOK_ARCHIVE_PATH' })
  }
  return path
}
