/**
 * CDP answers for the native-input protocol an Agent click uses (browser-page-dispatch.ts `nativeClick`).
 *
 * Fake transports in these tests already answer snapshot and ref resolution. A native click also asks
 * for the target's box, the node at its center, whether that node belongs to the target and whether
 * the pointer landed on it, then sends `Input.dispatchMouseEvent`. This double answers those as a page
 * where the target is uncovered at the center of its box, and records each press with the element it
 * landed on. It returns `undefined` for every other method so the caller's own double keeps answering.
 */
export const NATIVE_HIT_QUAD = [10, 10, 50, 10, 50, 30, 10, 30]

/** The native click's own geometry checks (hit ownership and pointer landing), never a page action. */
export function isNativeInputCheck(params: { functionDeclaration?: unknown } | undefined): boolean {
  const declaration = String(params?.functionDeclaration ?? '')
  return declaration.includes('self.labels') || declaration.includes(':hover')
}

/** The native text input's own prepare / read-back / focus-return steps, never a page action. */
export function isNativeTextStep(params: { functionDeclaration?: unknown } | undefined): 'prepare' | 'read' | 'restore' | null {
  const declaration = String(params?.functionDeclaration ?? '')
  if (declaration.includes('__agentMuxTextFocus = previous')) return 'prepare'
  if (declaration.includes('restoreFocus(this, previous)') && declaration.includes('__agentMuxTextFocus')) return 'restore'
  if (declaration.includes('isContentEditable ?')) return 'read'
  return null
}

/** The scroll a native click performs before reading geometry; the old synthetic click also scrolled in its action. */
export function isNativeScroll(params: { functionDeclaration?: unknown } | undefined): boolean {
  return String(params?.functionDeclaration ?? '').includes('inline: "center"')
}

export type NativePress = { target: number; x: number; y: number }

/**
 * @param backendOf maps a handle this double was asked about to its backend node id, so the node at
 *   the click point is the target itself and every press names the element it landed on.
 */
export function nativeInputDouble(backendOf: (objectId: string) => number = () => 1) {
  let target = 1
  const presses: NativePress[] = []
  // One text field per double: native text input selects (fill) or appends (type) and is read back.
  const field = { value: '', replace: true }
  const typed: { text: string }[] = []
  return {
    presses,
    typed,
    answer(method: string, params: Record<string, any> | undefined): unknown {
      const step = method === 'Runtime.callFunctionOn' ? isNativeTextStep(params) : null
      if (step === 'prepare') { field.replace = params?.arguments?.[0]?.value === true; return { result: { value: { ok: true, before: field.value, caret: 'set' } } } }
      if (step === 'read') return { result: { value: field.value } }
      if (step === 'restore') return { result: { value: null } }
      if (method === 'Input.insertText') { typed.push({ text: params?.text }); field.value = field.replace ? params?.text : field.value + params?.text; return {} }
      if (method === 'Input.dispatchKeyEvent') return {}
      if (method === 'DOM.getContentQuads') { target = backendOf(String(params?.objectId)); return { quads: [NATIVE_HIT_QUAD] } }
      if (method === 'DOM.getNodeForLocation') return { backendNodeId: target }
      if (method === 'Input.dispatchMouseEvent') {
        if (params?.type === 'mousePressed') presses.push({ target, x: params.x, y: params.y })
        return {}
      }
      if (method === 'Runtime.callFunctionOn' && isNativeInputCheck(params)) return { result: { value: true } }
      return undefined
    }
  }
}

/** A native press: the one Input command that means the click reached the page. */
export function isNativePress(method: string, params: Record<string, any> | undefined): boolean {
  return method === 'Input.dispatchMouseEvent' && params?.type === 'mousePressed'
}

/** A native action reaching the page: a click's press or a text insert. */
export function isNativeAction(method: string, params: Record<string, any> | undefined): boolean {
  return isNativePress(method, params) || method === 'Input.insertText'
}
