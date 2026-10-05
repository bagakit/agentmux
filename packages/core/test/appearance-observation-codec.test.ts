import { describe, expect, it, vi } from 'vitest'
import { parseAppearanceObservation } from '../src/public-rpc-settings-observation.js'

const snapshot = () => ({ sourceId: 'original-source', revision: 0, values: { themeId: 'custom.original', theme: { iconPaths: ['M 0 0 L 24 24'] } }, issues: [] })
describe('browser-safe appearance wire values stay opaque to Core', () => {
  it('preserves generic data and checks current source with strictly newer revisions', () => {
    const initial = parseAppearanceObservation(snapshot())
    expect(initial).toEqual(snapshot())
    expect(parseAppearanceObservation({ ...snapshot(), revision: 3 }, initial).revision).toBe(3)
    expect(() => parseAppearanceObservation(snapshot(), initial)).toThrow('not newer')
    expect(() => parseAppearanceObservation({ ...snapshot(), sourceId: 'another-owner', revision: 3 }, initial)).toThrow('another owner')
  })
  it.each([
    { ...snapshot(), revision: -1 }, { ...snapshot(), revision: 0.5 }, { ...snapshot(), sourceId: '' },
    { ...snapshot(), values: { bad: undefined } }, { ...snapshot(), values: [] },
    { ...snapshot(), issues: Array(1) }, { ...snapshot(), issues: [{ id: 'held', message: 'Retained', extra: true }] },
    { ...snapshot(), extra: true }
  ])('rejects malformed observation data without silently repairing it', raw => {
    expect(() => parseAppearanceObservation(raw)).toThrow()
  })
})


it('releases an acquired appearance producer when its opening violates the wire contract', async () => {
  const { AgentMuxRpcService } = await import('../src/public-rpc-service.js')
  const dispose = vi.fn(), start = vi.fn()
  const service = new AgentMuxRpcService({ coreClients: () => [], appearance: { subscribe: async () => ({
    initial: { ...snapshot(), revision: -1 } as never, start, dispose
  }) } })
  try {
    await expect(service.subscribe('settings.appearance.watch', {}, () => {})).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
    expect(dispose).toHaveBeenCalledOnce(); expect(start).not.toHaveBeenCalled()
  } finally { await service.dispose() }
})
