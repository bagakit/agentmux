import { expect, it } from 'vitest'
import { iconAssetSchema } from '../src/theme/schema.js'

it('rejects imported drawings entirely outside their fixed icon viewport', () => {
  for (const d of ['M80 80L90 90', 'M-40 -20L-10 -10', 'M4 80L20 90', 'M80 4L90 20']) {
    expect(iconAssetSchema.safeParse({ kind: 'paths', paths: [{ d }] }).success, d).toBe(false)
  }
})

it('keeps bounded imported curves and paths that actually intersect the icon viewport', () => {
  for (const d of ['M3 12L21 12', 'M-2 12L26 12', 'M-8 12Q12 -8 32 12', 'M2 12A10 10 180 0 1 22 12']) {
    expect(iconAssetSchema.safeParse({ kind: 'paths', paths: [{ d }] }).success, d).toBe(true)
  }
})
