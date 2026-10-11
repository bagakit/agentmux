/** Computed CSS is already parsed by the browser. Read only its normalized alpha, not a colour model. */
export function opaqueComputedColor(value: string): boolean {
  if (!value || value === 'transparent') return false
  const alpha = value.match(/\/\s*([\d.]+%?)\s*\)$/)?.[1]
    ?? (/^rgba\(/.test(value) ? value.match(/,\s*([\d.]+%?)\s*\)$/)?.[1] : undefined)
  return alpha === undefined || Number.parseFloat(alpha) === (alpha.endsWith('%') ? 100 : 1)
}

/** Native projection follows the same bounded portal stacking contexts as the original DOM. */
export function compareOverlayPaintOrder(
  left: Element,
  right: Element,
  topLayers: ReadonlyMap<Element, number>,
  styleOf: (node: Element) => CSSStyleDeclaration
): number {
  if (left === right) return 0
  const nativeOwner = (node: Element) => {
    const owner = node.closest('[popover]')
    return owner && topLayers.has(owner) ? owner : null
  }
  const aOwner = nativeOwner(left), bOwner = nativeOwner(right)
  const native = (topLayers.get(aOwner!) ?? 0) - (topLayers.get(bOwner!) ?? 0)
  if (native) return native
  const contexts = (node: Element, stop: Element | null): Element[] => {
    const result: Element[] = []
    for (let current: Element | null = node; current && current !== stop && current !== node.ownerDocument.body; current = current.parentElement) {
      const style = styleOf(current)
      if (current === node || current.hasAttribute('data-overlay-modal-scope') || style.zIndex && style.zIndex !== 'auto' ||
        style.isolation === 'isolate' || style.position === 'fixed' || style.position === 'sticky' ||
        Number(style.opacity || '1') < 1 || style.transform && style.transform !== 'none' ||
        style.filter && style.filter !== 'none' || /(?:paint|layout|strict|content)/.test(style.contain || '')) result.unshift(current)
    }
    return result
  }
  const a = contexts(left, aOwner), b = contexts(right, bOwner)
  let index = 0
  while (index < a.length && index < b.length && a[index] === b[index]) index++
  const branchA = a[index] ?? left, branchB = b[index] ?? right
  const rank = (node: Element) => Number.parseInt(styleOf(node).zIndex, 10) || 0
  const order = rank(branchA) - rank(branchB)
  return order || (branchA.compareDocumentPosition(branchB) & 4 ? -1 : 1)
}
