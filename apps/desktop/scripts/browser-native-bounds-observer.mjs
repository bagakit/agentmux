/** Private diagnostic only: preserve the original synchronous Main bounds method and its outcomes. */
export function installNativeBoundsObserver(prototype) {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'setBounds')
  if (!descriptor || typeof descriptor.value !== 'function') throw new Error('Original Main bounds method is unavailable')
  const original = descriptor.value, events = []
  let active = true, omitted = 0
  const record = value => { if (!active) return; if (events.length < 256) events.push(value); else omitted++ }
  function observed(id, bounds) {
    const safeId = typeof id === 'string' ? id.slice(0, 128) : undefined
    try {
      const values = bounds === null ? null : Object.getOwnPropertyDescriptors(bounds)
      const geometry = values === null ? null : Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, typeof values[key]?.value === 'number' ? values[key].value : undefined]))
      record({ stage: 'call', id: safeId, bounds: geometry })
    } catch { /* Observation must not change the original method's behavior. */ }
    try { const result = Reflect.apply(original, this, arguments); record({ stage: 'returned', id: safeId }); return result }
    catch (error) {
      let unknown = false
      try { const message = Object.getOwnPropertyDescriptor(error, 'message')?.value; unknown = typeof message === 'string' && message.startsWith('Unknown browser:') } catch {}
      record({ stage: 'threw', id: safeId, unknown }); throw error
    }
  }
  Object.defineProperty(prototype, 'setBounds', { ...descriptor, value: observed })
  const drain = () => ({ schema: 'agentmux.private-native-bounds-observer.v1', active, omitted, events: structuredClone(events) })
  return { drain, restore() {
    active = false
    if (Object.getOwnPropertyDescriptor(prototype, 'setBounds')?.value === observed) Object.defineProperty(prototype, 'setBounds', descriptor)
    return drain()
  } }
}
