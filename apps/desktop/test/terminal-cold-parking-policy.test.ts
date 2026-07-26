import { describe, expect, it } from 'vitest'
import {
  haveSameTerminalRegionIds,
  nextTerminalColdParkDelayMs,
  selectColdParkedTerminalRegions,
  type TerminalColdParkCandidate
} from '../src/renderer/src/lib/terminal-cold-parking-policy.js'

function candidate(
  id: string,
  hiddenSinceMs: number,
  overrides: Partial<TerminalColdParkCandidate> = {}
): TerminalColdParkCandidate {
  return {
    id,
    visible: false,
    navigationContextActive: true,
    hiddenSinceMs,
    lastActivatedSeq: Number(id.replace(/\D/g, '')) || 0,
    phase: 'attached',
    canRebuild: true,
    hasPendingInteraction: false,
    ...overrides
  }
}

describe('Terminal cold-park policy', () => {
  it('waits through the cold-park hysteresis window', () => {
    expect(selectColdParkedTerminalRegions(
      [candidate('region-1', 1_000)],
      { nowMs: 30_999, coldParkDelayMs: 30_000, hotRetainMs: 300_000, hotRetainLimit: 6 }
    )).toEqual(new Set())
    expect(nextTerminalColdParkDelayMs(
      [candidate('region-1', 1_000)],
      { nowMs: 1_001, coldParkDelayMs: 30_000, hotRetainMs: 300_000 }
    )).toBe(29_999)
  })

  it('keeps the most recently hidden region warm and parks the older tail', () => {
    const parked = selectColdParkedTerminalRegions(
      [candidate('region-1', 1_000), candidate('region-2', 2_000), candidate('region-3', 3_000)],
      { nowMs: 10_000, coldParkDelayMs: 1, hotRetainMs: 300_000, hotRetainLimit: 2 }
    )
    expect(parked).toEqual(new Set(['region-1']))
  })

  it('bounds the warm set even when all candidates are newer than the TTL', () => {
    const parked = selectColdParkedTerminalRegions(
      [candidate('region-1', 99), candidate('region-2', 98), candidate('region-3', 97)],
      { nowMs: 100, coldParkDelayMs: 1, hotRetainMs: 10_000, hotRetainLimit: 2 }
    )
    expect(parked).toEqual(new Set(['region-3']))
  })

  it('does not park visible, launching, pending, or non-rebuildable regions', () => {
    const candidates = [
      candidate('visible', 0, { visible: true }),
      candidate('launching', 0, { phase: 'launching' }),
      candidate('pending', 0, { hasPendingInteraction: true }),
      candidate('dead', 0, { canRebuild: false })
    ]
    expect(selectColdParkedTerminalRegions(candidates, {
      nowMs: 1_000,
      coldParkDelayMs: 1,
      hotRetainMs: 1,
      hotRetainLimit: 0
    })).toEqual(new Set())
  })

  it('honors disabled, measurement, and cooldown gates', () => {
    const regions = [candidate('region-1', 0)]
    const base = { nowMs: 1_000, coldParkDelayMs: 1, hotRetainMs: 1, hotRetainLimit: 0 }
    expect(selectColdParkedTerminalRegions(regions, { ...base, parkingEnabled: false })).toEqual(new Set())
    expect(selectColdParkedTerminalRegions(regions, { ...base, measurementActive: true })).toEqual(new Set())
    expect(selectColdParkedTerminalRegions(regions, { ...base, parkCooldownUntilMs: 2_000 })).toEqual(new Set())
    expect(nextTerminalColdParkDelayMs(regions, { ...base, parkCooldownUntilMs: 2_000 })).toBe(1_000)
  })

  it('never parks a Region from another Workspace or Scratch Topic context', () => {
    const regions = [candidate('region-hidden-context', 0, { navigationContextActive: false })]
    const policy = { nowMs: 1_000, coldParkDelayMs: 1, hotRetainMs: 1, hotRetainLimit: 0 }

    expect(selectColdParkedTerminalRegions(regions, policy)).toEqual(new Set())
    expect(nextTerminalColdParkDelayMs(regions, policy)).toBeNull()
  })

  it('compares region id sets without depending on insertion order', () => {
    expect(haveSameTerminalRegionIds(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(true)
    expect(haveSameTerminalRegionIds(new Set(['a']), new Set(['b']))).toBe(false)
  })
})
