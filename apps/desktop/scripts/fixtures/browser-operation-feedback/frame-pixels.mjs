// Test-only readback of the original NativeImage bitmap. This never draws a cue.
// A DOM read is a candidate, not the compositor frame's identity or timestamp.
const close = (a, b, tolerance = 4) => a.every((v, i) => Math.abs(v - b[i]) <= tolerance)
const bounds = pixels => ({ x: Math.min(...pixels.map(p => p.x)), y: Math.min(...pixels.map(p => p.y)),
  width: Math.max(...pixels.map(p => p.x)) - Math.min(...pixels.map(p => p.x)) + 1,
  height: Math.max(...pixels.map(p => p.y)) - Math.min(...pixels.map(p => p.y)) + 1 })

export function inspectFeedbackFrame(bitmap, sample) {
  const unknown = reason => ({ compatible: false, reason })
  const hud = sample?.hud
  if (!hud?.hostConnected || !['running', 'completed'].includes(hud.phase)) return unknown('candidate-has-no-visible-cue')
  const sx = bitmap.width / hud.viewport?.width, sy = bitmap.height / hud.viewport?.height
  if (!(sx > 0 && sy > 0) || Math.abs(sx - sy) > 0.01 || bitmap.bytes.length !== bitmap.width * bitmap.height * 4)
    return unknown('bitmap-viewport-scale-unknown')
  const pixel = (x, y) => {
    const offset = (y * bitmap.width + x) * 4
    return bitmap.order === 'bgra' ? [bitmap.bytes[offset + 2], bitmap.bytes[offset + 1], bitmap.bytes[offset]]
      : [bitmap.bytes[offset], bitmap.bytes[offset + 1], bitmap.bytes[offset + 2]]
  }
  const roi = rect => ({ x: Math.max(0, Math.floor(rect.x * sx)), y: Math.max(0, Math.floor(rect.y * sy)),
    right: Math.min(bitmap.width, Math.ceil((rect.x + rect.width) * sx)), bottom: Math.min(bitmap.height, Math.ceil((rect.y + rect.height) * sy)) })
  const scan = (rect, predicate) => {
    const r = roi(rect), found = []
    for (let y = r.y; y < r.bottom; y++) for (let x = r.x; x < r.right; x++) if (predicate(pixel(x, y))) found.push({ x, y })
    return found
  }
  const label = hud.label, executor = hud.executor
  if (!label && executor) return unknown('executor-phase-not-pixel-distinct')
  const text = label ?? executor
  const foreground = text?.paint?.outputColor, background = text?.paint?.outputBackground, opacity = Number(text?.opacity)
  if (!text?.text?.trim() || !foreground || !background || !(opacity > 0 && opacity <= 1) || !(background[3] > 0))
    return unknown('computed-text-paint-unavailable')
  // The label background is measured in its padding, away from glyphs/rounded corners.
  const paddingTop = Number.parseFloat(text.paint.paddingTop)
  const inner = { x: text.rect.x + 6, y: text.rect.y + Math.min(1.5, paddingTop / 2), width: text.rect.width - 12, height: 0.5 }
  const backgroundPixels = scan(inner, () => true).map(p => pixel(p.x, p.y))
  if (backgroundPixels.length < 3 || !(paddingTop > 0)) return unknown('text-background-roi-empty')
  const middle = [...backgroundPixels].sort((a, b) => a.reduce((n, v) => n + v, 0) - b.reduce((n, v) => n + v, 0))[Math.floor(backgroundPixels.length / 2)]
  if (middle.some(v => v > 100) || backgroundPixels.filter(p => close(p, middle)).length < backgroundPixels.length * 0.8)
    return unknown('text-background-not-present')
  const alpha = opacity * background[3]
  if (!(alpha < 1)) return unknown('opaque-text-background-cannot-infer-backdrop')
  const backdrop = middle.map((v, i) => (v - alpha * background[i]) / (1 - alpha))
  if (backdrop.some(v => v < -4 || v > 259)) return unknown('text-background-composition-unknown')
  const expectedText = foreground.slice(0, 3).map((v, i) => opacity * v + (1 - opacity) * backdrop[i])
  // A cached running label may cover the current completed label's smaller rectangle.
  // Require the actual painted right boundary, rather than accepting text anywhere in it.
  const outside = scan({ x: text.rect.x + text.rect.width + 2, y: text.rect.y + 5, width: 1, height: Math.max(1, text.rect.height - 10) }, p => close(p, middle, 5))
  if (outside.length >= 2 * sy) return unknown('text-paint-exceeds-candidate-label')
  const glyphs = scan({ x: text.rect.x + 4, y: text.rect.y + paddingTop, width: text.rect.width - 8,
    height: text.rect.height - paddingTop * 2 }, p => close(p, expectedText))
  if (glyphs.length < Math.ceil(6 * sx * sy)) return unknown('text-phase-paint-not-present')
  let arrowPixels = null
  if (hud.pointer) {
    const fill = hud.arrow?.paint?.outputFill, pointerOpacity = Number(hud.pointer.opacity)
    if (!fill || !(pointerOpacity > 0 && pointerOpacity <= 1)) return unknown('computed-arrow-paint-unavailable')
    const animation = hud.pointer.animations?.[0]
    const transforms = animation?.keyframes?.map(k => /^translate\(([-\d.]+)px,\s*([-\d.]+)px\)$/.exec(k.transform))
    if (transforms?.some(m => !m)) return unknown('arrow-route-unreadable')
    const xs = transforms?.length ? transforms.map(m => Number(m[1])) : [hud.arrow.rect.x]
    const ys = transforms?.length ? transforms.map(m => Number(m[2])) : [hud.arrow.rect.y]
    const rect = { x: Math.min(...xs), y: Math.min(...ys) - 2, width: Math.max(...xs) - Math.min(...xs) + hud.arrow.rect.width,
      height: Math.max(...ys) - Math.min(...ys) + hud.arrow.rect.height + 4 }
    const a = pointerOpacity * fill[3]
    const pixels = scan(rect, p => p.every((v, i) => v >= a * fill[i] - 3 && v <= a * fill[i] + (1 - a) * 255 + 3) &&
      p[1] - p[0] >= a * (fill[1] - fill[0]) - (1 - a) * 255 - 3 && p[1] - p[2] >= a * (fill[1] - fill[2]) - (1 - a) * 255 - 3)
    if (pixels.length < Math.ceil(hud.arrow.rect.width * hud.arrow.rect.height * sx * sy * 0.12)) return unknown('arrow-paint-not-present')
    const b = bounds(pixels)
    if (b.width > hud.arrow.rect.width * sx + 2 || b.height > hud.arrow.rect.height * sy + 2)
      return unknown('arrow-paint-not-a-single-local-glyph')
    arrowPixels = { count: pixels.length, bitmapBounds: b, cssBounds: { x: b.x / sx, y: b.y / sy, width: b.width / sx, height: b.height / sy } }
  } else if (!executor) return unknown('candidate-has-no-pointer-or-executor')
  return { compatible: true, basis: 'original-bitmap-cue-roi-and-computed-paint', phase: hud.phase,
    scale: { x: sx, y: sy }, textPixels: { count: glyphs.length, bitmapBounds: bounds(glyphs), expectedCore: expectedText,
      measuredBackground: middle, inferredBackdrop: backdrop, candidateText: text.text }, arrowPixels,
    limitation: 'Pixel compatibility is not a compositor timestamp or cryptographic operation identity; independent original image review remains required.' }
}
