import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { nativeProcessExecutable, nativeProcessFiles } from '../src/agent-native-process.js'
import * as runner from '../src/process-runner.js'

afterEach(() => vi.restoreAllMocks())

it.runIf(process.platform === 'darwin')('joins the kernel executable to its original mapped file and keeps the existing birth receipt unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amux-executable-proof-')), helper = join(root, 'native-process-proof')
  const compiled = await runner.runProcess('cc', ['-Wall', '-Wextra', '-Werror', fileURLToPath(new URL('../native/native-socket-peer.c', import.meta.url)), '-lproc', '-o', helper], { timeoutMs: 10_000 })
  expect(compiled).toMatchObject({ exitCode: 0, stderr: '' })
  const child = spawn(process.execPath, ['-e', 'console.log("ready");setInterval(()=>{},1000)'], { stdio: ['ignore', 'pipe', 'ignore'] })
  try {
    await once(child.stdout!, 'data')
    const original = runner.runProcess
    const receipts: string[][] = []
    vi.spyOn(runner, 'runProcess').mockImplementation(async (command, args, options) => {
      if (command.endsWith('/native-socket-peer-darwin')) { receipts.push([...args]); return await original(helper, args, options) }
      return await original(command, args, options)
    })
    const executable = await nativeProcessExecutable(child.pid!, AbortSignal.timeout(5000))
    const expected = await realpath(process.execPath), mapped = await stat(expected, { bigint: true })
    expect(executable).toEqual({ path: expected, device: mapped.dev, inode: mapped.ino })
    expect(receipts.filter(args => args[0] === '--process-executable')).toEqual([['--process-executable', String(child.pid)]])
    expect(receipts.filter(args => args[0] === '--process-identity')).toHaveLength(2)
    expect((await nativeProcessFiles(child.pid!, AbortSignal.timeout(5000), 'process')).some(file =>
      file.descriptor === 'txt' && file.path === executable.path && file.device === executable.device && file.inode === executable.inode)).toBe(true)
    const legacy = await original(helper, ['--process-identity', String(child.pid)], { timeoutMs: 2000 })
    expect(Object.keys(JSON.parse(legacy.stdout))).toEqual(['type', 'schema', 'pid', 'uid', 'startSec', 'startUsec'])
    expect(JSON.parse(legacy.stdout)).toMatchObject({ type: 'native-process-identity', schema: 1, pid: child.pid, uid: process.getuid?.() })
  } finally {
    const ended = once(child, 'exit'); child.kill('SIGTERM'); await ended
    await rm(root, { recursive: true })
  }
})

it.runIf(process.platform === 'darwin').each(['pid', 'uid', 'path'] as const)('rejects an unbound executable %s receipt before accepting a mapped path', async field => {
  const path = Buffer.from(process.execPath).toString('hex'), value = { type: 'native-process-executable', schema: 1,
    pid: process.pid, uid: process.getuid?.(), pathHex: path }
  const actual = runner.runProcess
  vi.spyOn(runner, 'runProcess').mockImplementation(async (command, args, options) => {
    if (args[0] === '--process-identity') return { exitCode: 0, stderr: '', stdout: JSON.stringify({
      type: 'native-process-identity', schema: 1, pid: process.pid, uid: process.getuid?.(), startSec: '1', startUsec: '0'
    }) }
    if (args[0] !== '--process-executable') return await actual(command, args, options)
    const receipt = { ...value, ...(field === 'pid' ? { pid: process.pid + 1 } : field === 'uid' ? { uid: -1 } : { pathHex: 'zz' }) }
    return { exitCode: 0, stdout: JSON.stringify(receipt), stderr: '' }
  })
  await expect(nativeProcessExecutable(process.pid, AbortSignal.timeout(3000))).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE' })
})
