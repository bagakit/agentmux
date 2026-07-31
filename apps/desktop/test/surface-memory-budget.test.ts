import { describe, expect, it } from 'vitest'
import {
  nextSurfaceMemoryDeadlineMs,
  selectSurfaceMemoryReleases,
  type SurfaceMemoryCandidate
} from '../src/renderer/src/lib/surface-memory-budget.js'

function candidate(
  id: string,
  kind: SurfaceMemoryCandidate['kind'],
  hiddenSinceMs: number,
  overrides: Partial<SurfaceMemoryCandidate> = {}
): SurfaceMemoryCandidate {
  return {
    id,
    kind,
    visible: false,
    navigationContextActive: true,
    hiddenSinceMs,
    lastActivatedSeq: Number(id.replace(/\D/g, '')) || 0,
    ownerPresent: true,
    canRebuild: true,
    protected: false,
    ...overrides
  }
}

describe('independent Browser/Monaco surface memory budget', () => {
  it('keeps Browser and Monaco limits independent', () => {
    const candidates = [
      candidate('m1', 'monaco', 0),
      candidate('m2', 'monaco', 1),
      candidate('b1', 'browser', 0),
      candidate('b2', 'browser', 1)
    ]
    const policy = { nowMs: 100, releaseDelayMs: 1, hotRetainMs: 10_000, hotRetainLimit: 1 }
    expect(selectSurfaceMemoryReleases(candidates, policy)).toEqual(new Set(['m1', 'b1']))
  })

  it('releases only after the delay or hot-retain expiry', () => {
    const value = candidate('m1', 'monaco', 1_000)
    expect(selectSurfaceMemoryReleases([value], {
      nowMs: 60_999,
      releaseDelayMs: 60_000,
      hotRetainMs: 300_000,
      hotRetainLimit: 4
    })).toEqual(new Set())
    expect(nextSurfaceMemoryDeadlineMs([value], {
      nowMs: 1_001,
      releaseDelayMs: 60_000,
      hotRetainMs: 300_000
    })).toBe(59_999)
    expect(selectSurfaceMemoryReleases([value], {
      nowMs: 301_000,
      releaseDelayMs: 60_000,
      hotRetainMs: 300_000,
      hotRetainLimit: 4
    })).toEqual(new Set(['m1']))
  })

  it('requires owner and rebuild proof and respects safety gates', () => {
    const candidates = [
      candidate('unowned', 'browser', 0, { ownerPresent: false }),
      candidate('unrebuildable', 'monaco', 0, { canRebuild: false }),
      candidate('protected', 'monaco', 0, { protected: true }),
      candidate('context-hidden', 'browser', 0, { navigationContextActive: false }),
      candidate('visible', 'monaco', 0, { visible: true })
    ]
    const policy = { nowMs: 1_000, releaseDelayMs: 1, hotRetainMs: 1, hotRetainLimit: 0 }
    expect(selectSurfaceMemoryReleases(candidates, policy)).toEqual(new Set())
    expect(selectSurfaceMemoryReleases(candidates, { ...policy, parkingEnabled: false })).toEqual(new Set())
    expect(selectSurfaceMemoryReleases(candidates, { ...policy, measurementActive: true })).toEqual(new Set())
    expect(selectSurfaceMemoryReleases(
      [candidate('cooldown', 'browser', 0)],
      { ...policy, releaseCooldownUntilMs: 2_000 }
    )).toEqual(new Set())
  })

  it('bounds each kind independently while retaining the newest hidden owners', () => {
    const candidates = [
      candidate('m-old', 'monaco', 1),
      candidate('m-new', 'monaco', 3),
      candidate('b-old', 'browser', 1),
      candidate('b-new', 'browser', 3)
    ]
    const released = selectSurfaceMemoryReleases(candidates, {
      nowMs: 10,
      releaseDelayMs: 1,
      hotRetainMs: 300_000,
      hotRetainLimit: 1
    })
    expect(released).toEqual(new Set(['m-old', 'b-old']))
  })

  it('keeps release selection deterministic when candidates arrive in a different order', () => {
    const candidates = [
      candidate('m-old', 'monaco', 1),
      candidate('m-new', 'monaco', 3),
      candidate('b-old', 'browser', 1),
      candidate('b-new', 'browser', 3)
    ]
    const policy = { nowMs: 10, releaseDelayMs: 1, hotRetainMs: 300_000, hotRetainLimit: 1 }
    expect(selectSurfaceMemoryReleases([...candidates].reverse(), policy)).toEqual(new Set(['m-old', 'b-old']))
  })
})
