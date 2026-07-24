import { describe, expect, it, vi } from 'vitest'
import { FileObservationRegistry } from '../src/main/file-observation-registry.js'

describe('FileObservationRegistry', () => {
  it('shares a pending observation and disposes its single owner', async () => {
    const registry = new FileObservationRegistry()
    const dispose = vi.fn()
    let resolveStart!: (dispose: () => void) => void
    const start = vi.fn(() => new Promise<() => void>((resolve) => {
      resolveStart = resolve
    }))

    const first = registry.observe('workspace\0file.ts', start)
    const second = registry.observe('workspace\0file.ts', start)
    expect(start).toHaveBeenCalledTimes(1)

    resolveStart(dispose)
    await Promise.all([first, second])
    await registry.unobserve('workspace\0file.ts')
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('allows retry after a failed observation start', async () => {
    const registry = new FileObservationRegistry()
    const dispose = vi.fn()
    await expect(registry.observe('workspace\0file.ts', async () => {
      throw new Error('observer failed')
    })).rejects.toThrow('observer failed')

    await registry.observe('workspace\0file.ts', async () => dispose)
    await registry.dispose()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('rejects observation starts after disposal', async () => {
    const registry = new FileObservationRegistry()
    await registry.dispose()
    await expect(registry.observe('workspace\0file.ts', async () => () => {}))
      .rejects.toThrow('File observation registry is disposed')
  })
})
