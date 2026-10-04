let terminalViews = 0
let terminalAddons = 0
let terminalListeners = 0

export function acquireTerminalResourceOwners(input: {
  addons: number
  listeners: number
}): { setAddons(addons: number): void; release(): void } {
  terminalViews += 1
  terminalAddons += input.addons
  terminalListeners += input.listeners
  let addons = input.addons
  let released = false
  return {
    setAddons(next) {
      if (released) return
      terminalAddons += next - addons
      addons = next
    },
    release() {
      if (released) return
      released = true
      terminalViews -= 1
      terminalAddons -= addons
      terminalListeners -= input.listeners
    }
  }
}

export function terminalResourceOwnerCounts() {
  return { terminalViews, terminalAddons, terminalListeners }
}
