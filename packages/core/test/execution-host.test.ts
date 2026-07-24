import { describe, expect, it, vi } from 'vitest'
import { ExecutionHostRegistry, SshExecutionHost, type ExecutionHost } from '../src/execution-host.js'

describe('SshExecutionHost', () => {
  it('fails closed while the ctxmux Remote contract is unavailable', async () => {
    const host = new SshExecutionHost({
      id: 'buildbox',
      hostname: 'dev.example.com',
      user: 'river'
    })
    await expect(host.run('true', [])).rejects.toMatchObject({ code: 'REMOTE_UNSUPPORTED' })
    await expect(host.exposeLoopbackPort(39281)).rejects.toMatchObject({ code: 'REMOTE_UNSUPPORTED' })
  })
})

describe('ExecutionHostRegistry', () => {
  it('returns a removed host so the transaction owner controls disposal', async () => {
    const dispose = vi.fn(async () => {})
    const host: ExecutionHost = {
      id: 'retired',
      kind: 'ssh',
      label: 'Retired host',
      run: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
      exposeLoopbackPort: vi.fn(async (port: number) => port),
      dispose
    }
    const registry = new ExecutionHostRegistry([host])
    const removed = registry.remove(host.id)
    expect(removed).toBe(host)
    await removed?.dispose()
    expect(dispose).toHaveBeenCalledOnce()
    expect(() => registry.get(host.id)).toThrow('Unknown execution host')
  })
})
