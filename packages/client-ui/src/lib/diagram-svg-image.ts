/** Percentage-sized SVGs need an intrinsic viewport when consumed as an image, outside their
 * renderer's DOM. Preserve fixed-size exports; use the SVG protocol's own viewBox for fluid roots. */
export function diagramSvgImage(svg: string): Blob {
  const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement
  const fluid = (attribute: string) => !root.hasAttribute(attribute) || root.getAttribute(attribute)!.trim().endsWith('%')
  if (root.localName === 'svg' && (fluid('width') || fluid('height'))) {
    const box = root.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number)
    if (box?.length === 4 && box.every(Number.isFinite) && box[2]! > 0 && box[3]! > 0) {
      root.setAttribute('width', String(box[2]))
      root.setAttribute('height', String(box[3]))
      svg = new XMLSerializer().serializeToString(root)
    }
  }
  return new Blob([svg], { type: 'image/svg+xml' })
}
