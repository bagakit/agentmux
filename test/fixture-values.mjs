/** Shared browser/Node fixtures, derived from the module location rather than a machine root. */
const moduleLocation = import.meta.url
const fixtureBase = new URL('../fixture/', moduleLocation)
const fixtureRoot = decodeURIComponent(fixtureBase.pathname).replace(/\/$/, '')

export function fixturePath(relativePath) {
  return `${fixtureRoot}/${relativePath}`
}

export function fixtureFileUrl(relativePath) {
  const url = new URL('file:' + fixtureBase.pathname)
  url.pathname = fixturePath(relativePath)
  return url.href
}

/** Relative instants keep packet format tests independent of a calendar date. */
export function fixtureIso(offsetMs = 0) {
  const dayMs = 24 * 60 * 60 * 1000
  return new Date(dayMs + offsetMs).toISOString()
}
