export function normalizeExternalUrl(rawUrl: string): string {
  const url = new URL(rawUrl)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`External URL protocol is not allowed: ${url.protocol}`)
  }
  return url.toString()
}
