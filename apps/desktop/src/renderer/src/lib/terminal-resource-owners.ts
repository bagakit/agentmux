let terminalViews = 0
let terminalAddons = 0
let terminalListeners = 0

export function acquireTerminalResourceOwners(input: {
  addons: number
  listeners: number
}): () => void {
  terminalViews += 1
  terminalAddons += input.addons
  terminalListeners += input.listeners
  let released = false
  return () => {
    if (released) return
    released = true
    terminalViews -= 1
    terminalAddons -= input.addons
    terminalListeners -= input.listeners
  }
}

export function terminalResourceOwnerCounts() {
  return { terminalViews, terminalAddons, terminalListeners }
}
