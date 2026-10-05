import { afterEach, beforeEach } from 'vitest'

// LAN HTTP exposes getRandomValues but omits the secure-context-only randomUUID.
// Keep the real entropy API and every existing consumer fixture unchanged.
let original: PropertyDescriptor | undefined
beforeEach(() => {
  original = Object.getOwnPropertyDescriptor(globalThis.crypto, 'randomUUID')
  Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: undefined })
})
afterEach(() => {
  if (original) Object.defineProperty(globalThis.crypto, 'randomUUID', original)
  else Reflect.deleteProperty(globalThis.crypto, 'randomUUID')
})
