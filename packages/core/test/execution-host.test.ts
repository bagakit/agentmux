import { describe, expect, it, vi } from 'vitest'
import { ExecutionHostRegistry, SshExecutionHost, type ExecutionHost } from '../src/execution-host.js'
import type { ProcessRunner } from '../src/process-runner.js'

describe('SshExecutionHost', () => {
  it('separates local ssh argv from quoted remote argv', async () => {
    const runner = vi.fn<ProcessRunner>().mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 })
    const host = new SshExecutionHost({
      id: 'buildbox',
      hostname: 'dev.example.com',
      user: 'river',
      port: 2222,
      identityFile: '/keys/dev key',
      runner
    })
    await host.run('tmux', ['new-session', '-s', 'safe name', '--', 'printf', "it's data"], {
      env: { DEMO_VALUE: 'a b' },
      input: 'stdin bytes'
    })

    const call = runner.mock.calls[0]
    expect(call).toBeDefined()
    const [command, args, options] = call!
    expect(command).toBe('ssh')
    expect(args.slice(0, -2)).toEqual([
      '-T',
      '-o',
      'ConnectTimeout=10',
      '-p',
      '2222',
      '-i',
      '/keys/dev key',
      '--'
    ])
    expect(args.at(-2)).toBe('river@dev.example.com')
    expect(args.at(-1)).toContain("'DEMO_VALUE=a b'")
    expect(args.at(-1)).toContain("'safe name'")
    expect(args.at(-1)).toContain('"it\'s data"')
    expect(options?.input).toBe('stdin bytes')
  })

  it('rejects unsafe destinations', async () => {
    const host = new SshExecutionHost({ id: 'bad', hostname: 'host name' })
    await expect(host.run('true', [])).rejects.toMatchObject({ code: 'INVALID_SSH_DESTINATION' })
  })

  it('exposes the local hook server through one authenticated SSH reverse tunnel', async () => {
    const runner = vi.fn<ProcessRunner>()
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '43127\n', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: 'Exit request sent.\n', stderr: '', exitCode: 0 })
    const host = new SshExecutionHost({
      id: 'buildbox',
      hostname: 'dev.example.com',
      user: 'river',
      runner
    })

    await expect(host.exposeLoopbackPort(39281)).resolves.toBe(43127)
    await expect(host.exposeLoopbackPort(39281)).resolves.toBe(43127)
    expect(runner).toHaveBeenCalledTimes(2)

    const masterArgs = runner.mock.calls[0]?.[1] ?? []
    expect(masterArgs).toEqual(expect.arrayContaining(['-M', '-f', '-N', '-T', 'river@dev.example.com']))
    const controlPath = masterArgs[masterArgs.indexOf('-S') + 1]
    expect(typeof controlPath).toBe('string')
    expect(runner.mock.calls[1]?.[1]).toEqual([
      '-S',
      controlPath,
      '-O',
      'forward',
      '-R',
      '127.0.0.1:0:127.0.0.1:39281',
      '--',
      'river@dev.example.com'
    ])

    await host.dispose()
    expect(runner.mock.calls[2]?.[1]).toEqual([
      '-S',
      controlPath,
      '-O',
      'exit',
      '--',
      'river@dev.example.com'
    ])
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
