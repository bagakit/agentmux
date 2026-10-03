let terminalViews = 0
let terminalAddons = 0
let terminalListeners = 0

export function acquireTerminalResourceOwners(input: {
  addons: number
  listeners: number
}): { setAddons(addons: number): void; acquireListeners(listeners: number): () => void; release(): void } {
  terminalViews += 1
  terminalAddons += input.addons
  terminalListeners += input.listeners
  let listeners = input.listeners
  let addons = input.addons
  let released = false
  return {
    setAddons(next) {
      if (released) return
      terminalAddons += next - addons
      addons = next
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
      terminalAddons -= addons
      terminalListeners -= listeners
    }
  }
}

export function terminalResourceOwnerCounts() {
  return { terminalViews, terminalAddons, terminalListeners }
}
