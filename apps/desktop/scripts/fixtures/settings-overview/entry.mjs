// Controlled Renderer visibility input. This is not an OS/App visibility claim.
let visibility = 'visible'
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
await import('../settings-structure/entry.mjs')
window.overviewProbe = {
  ...window.structureProbe,
  setVisibility(value) {
    visibility = value
    document.dispatchEvent(new Event('visibilitychange'))
  }
}
