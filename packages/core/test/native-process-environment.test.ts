import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { nativeProcessEnvironment } from '../src/agent-native-process.js'
import * as runner from '../src/process-runner.js'

let directory: string, helper: string
const children: ChildProcess[] = []
const execute = runner.runProcess
const unavailable = { code: 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE' }
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'amux-process-environment-')); helper = join(directory, 'native-process')
  if (process.platform === 'darwin') {
    let source = fileURLToPath(new URL('../native/native-socket-peer.c', import.meta.url))
    if (process.env.AMX_NATIVE_ENV_MUTATION === 'skip-argv') {
      const original = await readFile(source, 'utf8'), anchor = 'for(int i=0;i<count;i++) {'
      if (original.split(anchor).length !== 2) throw new Error('Environment mutation must change one actual native argument boundary')
      source = join(directory, 'native-mutant.c'); await writeFile(source, original.replace(anchor, 'for(int i=0;i<1;i++) {'))
    }
    const result = await execute('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', source, '-o', helper], { timeoutMs: 10000 })
    expect(result).toMatchObject({ exitCode: 0, stderr: '' })
  }
})
beforeEach(() => {
  vi.spyOn(runner, 'runProcess').mockImplementation((command, args, options) => execute(command.endsWith('/native-socket-peer-darwin') ? helper : command, args, options))
})
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) {
    const ended = once(child, 'exit'); child.kill('SIGTERM'); await ended
  }
})
afterAll(async () => { await rm(directory, { recursive: true, force: true }) })
async function child(environment: Record<string, string> = {}) {
  const process = spawn(globalThis.process.execPath, ['-e', 'console.log("ready");setInterval(()=>{},1000)',
    'ARGUMENT_LOOKS_LIKE_ENV=must-not-be-read', 'opaque input\n权限🔒', ''], {
    env: environment, stdio: ['ignore', 'pipe', 'pipe']
  })
  children.push(process); await once(process.stdout!, 'data')
  return process
}

it.runIf(['darwin', 'linux'].includes(process.platform))('reads the exact original child environment, including inherited extra values and NUL-separated Unicode, without observer defaults or argv input', async () => {
  vi.stubEnv('DAEMON_ONLY_AUTH_CONTEXT', 'different-observer-value')
  vi.stubEnv('OBSERVER_ONLY_AUTH_CONTEXT', 'must-not-leak')
  const original = { HOME: directory, PATH: '/usr/bin:/bin', DAEMON_ONLY_AUTH_CONTEXT: 'original-daemon-extra',
    EMPTY: '', SPACES: ' space value ', UNICODE: '权限🔒 é e\u0301', MULTILINE: 'line1\nline2\rline3', EQUALS: 'first=second=third',
    LARGE: 'x'.repeat(96 * 1024), ...Object.fromEntries([['__proto__', 'literal-own-key']]) }
  const process = await child(original)
  const out = vi.spyOn(globalThis.process.stdout, 'write'), err = vi.spyOn(globalThis.process.stderr, 'write')
  const value = await nativeProcessEnvironment(process.pid!, AbortSignal.timeout(5000))
  expect(out).not.toHaveBeenCalled(); expect(err).not.toHaveBeenCalled()
  out.mockRestore(); err.mockRestore()
  expect(value).toMatchObject(original)
  expect(Object.hasOwn(value, 'OBSERVER_ONLY_AUTH_CONTEXT')).toBe(false)
  expect(Object.hasOwn(value, 'ARGUMENT_LOOKS_LIKE_ENV')).toBe(false)
  expect(Object.hasOwn(value, '__proto__')).toBe(true)
  expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
  expect(process.exitCode).toBeNull(); expect(process.signalCode).toBeNull()
})

it.runIf(process.platform === 'darwin')('uses package-owned kernel observations rather than ps text, and rechecks the same birth after the private environment receipt', async () => {
  const process = await child({ HOME: directory, ORIGINAL: 'present' })
  const calls: string[][] = []
  vi.mocked(runner.runProcess).mockImplementation((command, args, options) => {
    expect(command.endsWith('/native-socket-peer-darwin')).toBe(true)
    calls.push([...args]); return execute(helper, args, options)
  })
  expect((await nativeProcessEnvironment(process.pid!, AbortSignal.timeout(5000))).ORIGINAL).toBe('present')
  expect(calls).toEqual([['--process-identity', String(process.pid)], ['--process-environment', String(process.pid)], ['--process-identity', String(process.pid)]])
})

it.runIf(process.platform === 'darwin').each(['pid', 'uid', 'birth', 'schema', 'invalid-hex', 'invalid-utf8', 'missing-nul', 'duplicate-key', 'empty-key'] as const)('keeps an unbound or unrepresentable %s environment unavailable without exposing its payload', async field => {
  const process = await child({ ORIGINAL_SECRET_MARKER: 'private-fixture-secret' })
  vi.mocked(runner.runProcess).mockImplementation(async (_command, args, options) => {
    const result = await execute(helper, args, options)
    if (args[0] !== '--process-environment') return result
    const receipt = JSON.parse(result.stdout)
    if (field === 'pid') receipt.pid++
    if (field === 'uid') receipt.uid++
    if (field === 'birth') receipt.startSec = String(BigInt(receipt.startSec) + 1n)
    if (field === 'schema') receipt.schema = 2
    if (field === 'invalid-hex') receipt.environmentHex = 'zz'
    if (field === 'invalid-utf8') receipt.environmentHex = 'ff00'
    if (field === 'missing-nul') receipt.environmentHex = Buffer.from('SECRET=private-fixture-secret').toString('hex')
    if (field === 'duplicate-key') receipt.environmentHex = Buffer.from('SECRET=private-fixture-secret\0SECRET=ambiguous\0').toString('hex')
    if (field === 'empty-key') receipt.environmentHex = Buffer.from('=private-fixture-secret\0').toString('hex')
    return { ...result, stdout: JSON.stringify(receipt) }
  })
  const result = await nativeProcessEnvironment(process.pid!, AbortSignal.timeout(5000)).then(value => ({ value }), error => ({ error }))
  expect(result).toHaveProperty('error')
  expect('error' in result ? result.error : undefined).toMatchObject(unavailable)
  expect(JSON.stringify(result)).not.toContain('private-fixture-secret')
  expect(process.exitCode).toBeNull()
})

it.runIf(process.platform === 'darwin')('rejects a process whose final birth recheck changed and keeps that original child alive', async () => {
  const process = await child({ ORIGINAL: 'present' }); let identities = 0
  vi.mocked(runner.runProcess).mockImplementation(async (_command, args, options) => {
    const result = await execute(helper, args, options)
    if (args[0] === '--process-identity' && ++identities === 2) {
      const receipt = JSON.parse(result.stdout); receipt.startSec = String(BigInt(receipt.startSec) + 1n)
      return { ...result, stdout: JSON.stringify(receipt) }
    }
    return result
  })
  await expect(nativeProcessEnvironment(process.pid!, AbortSignal.timeout(5000))).rejects.toMatchObject(unavailable)
  expect(identities).toBe(2); expect(process.exitCode).toBeNull()
})

it.runIf(process.platform === 'darwin')('keeps missing-helper observations unavailable without replacing the healthy process or falling back to observer environment', async () => {
  const process = await child({ ORIGINAL: 'present' })
  vi.mocked(runner.runProcess).mockRejectedValue(Object.assign(new Error('missing private helper'), { code: 'ENOENT' }))
  await expect(nativeProcessEnvironment(process.pid!, AbortSignal.timeout(5000))).rejects.toMatchObject(unavailable)
  expect(process.exitCode).toBeNull(); expect(process.signalCode).toBeNull()
})

it.runIf(process.platform === 'darwin')('returns no environment bytes for invalid or already exited process identities', async () => {
  const process = await child({ ORIGINAL: 'present' }), ended = once(process, 'exit')
  process.kill('SIGTERM'); await ended
  const result = await execute(helper, ['--process-environment', String(process.pid)], { timeoutMs: 2000 })
  expect(result.exitCode).toBe(1); expect(result.stdout).toBe('')
  await expect(nativeProcessEnvironment(process.pid!, AbortSignal.timeout(5000))).rejects.toMatchObject(unavailable)
})

it.runIf(process.platform === 'darwin')('keeps an empty or OS-redacted Darwin environment unavailable rather than inventing observer defaults', async () => {
  const process = await child()
  await expect(nativeProcessEnvironment(process.pid!, AbortSignal.timeout(5000))).rejects.toMatchObject(unavailable)
  expect(process.exitCode).toBeNull()
})

it('preserves cancellation and an unsupported Host as unknown, without any subprocess', async () => {
  const abort = new AbortController(); abort.abort(new Error('original cancellation'))
  await expect(nativeProcessEnvironment(globalThis.process.pid, abort.signal)).rejects.toThrow('original cancellation')
  vi.spyOn(globalThis.process, 'platform', 'get').mockReturnValue('win32')
  await expect(nativeProcessEnvironment(globalThis.process.pid, AbortSignal.timeout(1000))).rejects.toMatchObject(unavailable)
  expect(runner.runProcess).not.toHaveBeenCalled()
})
