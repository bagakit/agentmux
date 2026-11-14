import { Window } from 'happy-dom'
import { afterAll } from 'vitest'

// Keep Node's native fetch/Request/Response for the actual HTTP device carrier.
// Only presentation globals come from the DOM implementation.
const window = new Window({ url: 'http://127.0.0.1/' })
const names = ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLButtonElement', 'HTMLTextAreaElement', 'HTMLFormElement', 'Event', 'MouseEvent', 'PointerEvent', 'CustomEvent', 'Document', 'DocumentFragment', 'Text', 'MutationObserver', 'getComputedStyle'] as const
const original = new Map<string, PropertyDescriptor | undefined>()
for (const name of names) {
  original.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  const value = name === 'window' ? window : name === 'getComputedStyle' ? window.getComputedStyle.bind(window) : window[name]
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
}
afterAll(async () => {
  await window.happyDOM.close()
  for (const [name, descriptor] of original) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name)
})
