// Reuse the qualified real components, appearance, Monaco and configuration IPC.
// The new host adds the production settings-page ancestor; no control CSS is overridden.
import '../toolkit-custom-identity/entry'

const hoverEvents: { trusted: boolean; nameInput: boolean; x: number; y: number }[] = []
;(window as any).craftHoverEvents = hoverEvents
document.addEventListener('mousemove', event => {
  hoverEvents.push({ trusted: event.isTrusted, nameInput: event.target === document.querySelector('.toolkit-editor__name input'), x: event.clientX, y: event.clientY })
})
