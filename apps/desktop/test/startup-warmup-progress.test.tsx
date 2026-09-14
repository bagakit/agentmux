import { describe, expect, it, vi } from 'vitest'
import { beginRendererStartup, startupProgressDetail } from '../src/renderer/src/lib/startup-progress'

describe('startup warmup progress', () => {
  it('describes phases without inventing progress when no total is known', () => {
    expect(startupProgressDetail({ step: 'saved-workspace' })).toContain('saved workspace')
    expect(startupProgressDetail({ step: 'runtime' })).toContain('Runtime')
    expect(startupProgressDetail({ step: 'sessions', current: 2, total: 4 })).toContain('2 of 4')
  })

  it('announces a mounted renderer before slow workspace recovery completes', async () => {
    const ready = vi.fn(async () => undefined)
    let resolveInitialize!: (value: string) => void
    const initialize = vi.fn(() => new Promise<string>((resolve) => { resolveInitialize = resolve }))
    const startup = beginRendererStartup(initialize, ready)
    expect(ready).toHaveBeenCalledTimes(1)
    expect(initialize).toHaveBeenCalledTimes(1)
    resolveInitialize('recovered')
    await expect(startup).resolves.toBe('recovered')
  })
})
