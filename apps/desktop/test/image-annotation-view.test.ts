import { describe, expect, it } from 'vitest'
import { fitImageView, imagePoint, zoomImageView } from '../src/renderer/src/components/image-annotation/view'

describe('image annotation viewport coordinates', () => {
  it('fits both landscape and portrait source pixels inside the available canvas with centered margins', () => {
    expect(fitImageView(240, 120, 400, 300)).toEqual({ scale: .4, x: 40, y: 0 })
    expect(fitImageView(240, 120, 100, 400)).toEqual({ scale: .3, x: 105, y: 0 })
    expect(fitImageView(400, 300, 100, 50)).toEqual({ scale: 4, x: 0, y: 50 })
  })

  it('keeps the image point under a noncentral wheel anchor while zooming a panned view', () => {
    const before = { scale: .4, x: -20, y: 15 }, anchor = { x: 60, y: 75 }
    const original = imagePoint(before, anchor)
    expect(original).toEqual({ x: 200, y: 150 })
    const after = zoomImageView(before, 2, anchor)
    expect(after).toEqual({ scale: 2, x: -340, y: -225 })
    expect(imagePoint(after, anchor)).toEqual(original)
  })

  it('maps captured pointer endpoints beyond the visible viewport into original image pixels', () => {
    const view = { scale: 2, x: -120, y: -80 }
    expect(imagePoint(view, { x: -40, y: 100 })).toEqual({ x: 40, y: 90 })
    expect(imagePoint(view, { x: 320, y: 200 })).toEqual({ x: 220, y: 140 })
  })
})
