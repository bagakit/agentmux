import { fixturePath } from './helpers/fixture-values.js'
import { access, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ExecutionHostRegistry, SshExecutionHost, type ExecutionHost } from '../src/execution-host.js'
import { runProcess, type ProcessRunner } from '../src/process-runner.js'

describe('SshExecutionHost transient workspace commands', () => {
  it('preserves cwd, literal argv, environment and binary stdin through the remote shell', async () => {
    const root = await mkdtemp(fixturePath("tmp/am-ssh-argv-"))
    const cwd = join(root, 'folder with spaces')
    await mkdir(cwd)
    const sentinel = join(root, 'must-not-exist')
    const payload = `literal ' quote $(touch '${sentinel}') \`touch '${sentinel}'\`\nlast line`
    const runner: ProcessRunner = vi.fn(async (command, args, options) => {
      expect(command).toBe('ssh')
      expect(args.slice(0, 4)).toEqual(['-T', '-o', 'BatchMode=yes', '-o'])
      expect(args.slice(-3, -1)).toEqual(['--', 'operator@fixture.invalid'])
      expect(args).toContain('ClearAllForwardings=yes')
      expect(args).toContain('ConnectTimeout=7')
      expect(args).toContain('2222')
      expect(options).not.toHaveProperty('cwd')
      expect(options).not.toHaveProperty('env')
      return await runProcess('/bin/sh', ['-c', args.at(-1)!], options)
    })
    const host = new SshExecutionHost({ id: 'remote', hostname: 'fixture.invalid', user: 'operator',
      port: 2222, connectTimeoutSeconds: 7, runner })
    const input = new Uint8Array([0, 10, 255, 4])
    try {
      const result = await host.run(process.execPath, ['-e',
        'let n=0;process.stdin.on("data",v=>n+=v.length);process.stdin.on("end",()=>process.stdout.write(JSON.stringify({cwd:process.cwd(),arg:process.argv[1],value:process.env.AGENTMUX_TEST_VALUE,removed:process.env.PATH,input:n})))', payload],
      { cwd, env: { AGENTMUX_TEST_VALUE: payload, PATH: undefined }, input, timeoutMs: 5000, maxOutputBytes: 8192 })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe(JSON.stringify({ cwd: await realpath(cwd), arg: payload, value: payload, input: input.byteLength }))
      await expect(access(sentinel)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(runner).toHaveBeenCalledOnce()
    } finally { await rm(root, { recursive: true }) }
  })

  it('preserves nonzero remote exit facts and never invents success', async () => {
    const runner = vi.fn(async () => ({ stdout: '', stderr: 'remote directory missing', exitCode: 1 }))
    const host = new SshExecutionHost({ id: 'remote', hostname: 'fixture.invalid', runner })
    await expect(host.run('test', ['-d', fixturePath("missing")])).resolves.toEqual({ stdout: '', stderr: 'remote directory missing', exitCode: 1 })
  })

  it('rejects invalid transport and shell tokens before invoking SSH', async () => {
    expect(() => new SshExecutionHost({ id: 'remote', hostname: '-oProxyCommand=bad' })).toThrow('invalid')
    expect(() => new SshExecutionHost({ id: 'remote', hostname: 'fixture.invalid', port: 0 })).toThrow('invalid')
    const runner = vi.fn()
    const host = new SshExecutionHost({ id: 'remote', hostname: 'fixture.invalid', runner })
    await expect(host.run('test', ['bad\0argument'])).rejects.toMatchObject({ code: 'INVALID_COMMAND' })
    await expect(host.run('test', [], { env: { 'BAD;KEY': 'literal' } })).rejects.toMatchObject({ code: 'INVALID_COMMAND' })
    expect(runner).not.toHaveBeenCalled()
  })
})

describe('ExecutionHostRegistry', () => {
  it('returns a removed host so the transaction owner controls disposal', async () => {
    const dispose = vi.fn(async () => {})
    const host: ExecutionHost = { id: 'retired', kind: 'ssh', label: 'Retired host',
      run: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })), dispose }
    const registry = new ExecutionHostRegistry([host])
    const removed = registry.remove(host.id)
    expect(removed).toBe(host)
    await removed?.dispose()
    expect(dispose).toHaveBeenCalledOnce()
    expect(() => registry.get(host.id)).toThrow('Unknown execution host')
  })
})
