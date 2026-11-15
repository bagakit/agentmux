let terminalViews = 0
let terminalBaseAddons = 0
let terminalWebglAddons = 0
let terminalWebglAddonViews = 0
let terminalListeners = 0

export function acquireTerminalResourceOwners(input: {
  addons: number
  listeners: number
}): { acquireAddon(kind?: 'webgl'): () => void; acquireListeners(listeners: number): () => void; release(): void } {
  terminalViews += 1
  terminalBaseAddons += input.addons
  terminalListeners += input.listeners
  let listeners = input.listeners
  let baseAddons = input.addons
  let webglAddons = 0
  let released = false
  return {
    acquireAddon(kind) {
      if (released) return () => {}
      if (kind === 'webgl') {
        if (webglAddons === 0) terminalWebglAddonViews++
        terminalWebglAddons++
        webglAddons++
      } else {
        terminalBaseAddons++
        baseAddons++
      }
      let active = true
      return () => {
        if (!active || released) return
        active = false
        if (kind === 'webgl') {
          terminalWebglAddons--
          webglAddons--
          if (webglAddons === 0) terminalWebglAddonViews--
        } else {
          terminalBaseAddons--
          baseAddons--
        }
      }
    },
    acquireListeners(count) {
      if (released) return () => {}
      terminalListeners += count
      listeners += count
      let active = true
      return () => {
        if (!active || released) return
        active = false
        terminalListeners -= count
        listeners -= count
      }
    },
    release() {
      if (released) return
      released = true
      terminalViews -= 1
      terminalBaseAddons -= baseAddons
      terminalWebglAddons -= webglAddons
      if (webglAddons > 0) terminalWebglAddonViews--
      terminalListeners -= listeners
    }
  }
}

export function terminalResourceOwnerCounts() {
  return { terminalViews, terminalAddons: terminalBaseAddons + terminalWebglAddons, terminalListeners }
}

export function terminalAddonOwnerCounts() {
  return { terminalBaseAddons, terminalWebglAddons, terminalWebglAddonViews }
}
