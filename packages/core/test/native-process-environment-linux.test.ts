import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('node:fs/promises', () => ({ open: vi.fn(), readFile: vi.fn(), stat: vi.fn(), readdir: vi.fn(), readlink: vi.fn() }))
vi.mock('../src/process-runner.js', () => ({ runProcess: vi.fn() }))
import * as fs from 'node:fs/promises'
import { runProcess } from '../src/process-runner.js'
import { nativeProcessEnvironment } from '../src/agent-native-process.js'

const pid = 123, directory = '/proc/self/fd/900'
let payload: Buffer, afterRead: boolean, changed: string
const close = vi.fn(async () => {})
const statRecord = () => `${pid} (native ) process) ${['S', '1', '123', '123', ...Array(15).fill('0'), '91234', '0'].join(' ')}\n`
const object = (inode = 100n, uid = BigInt(process.getuid!())) => ({ dev: 65025n, ino: inode, uid, isDirectory: () => true })
beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
  afterRead = false; changed = ''; close.mockReset().mockResolvedValue(undefined)
  payload = Buffer.from('HOME=/original\0DAEMON_ONLY_AUTH_CONTEXT=extra\0UNICODE=权限🔒\0MULTILINE=a\nb=c\0EMPTY=\0')
  vi.mocked(fs.open).mockImplementation(async path => {
    expect(path).toBe(`/proc/${pid}`)
    return { fd: 900, stat: async () => object(), close } as unknown as fs.FileHandle
  })
  vi.mocked(fs.readFile).mockImplementation(async path => {
    if (path === directory + '/stat') {
      if (changed === 'exited' && afterRead) throw Object.assign(new Error('process vanished'), { code: 'ESRCH' })
      return statRecord() as never
    }
    expect(path).toBe(directory + '/environ'); afterRead = true
    if (changed === 'permission') throw Object.assign(new Error('denied'), { code: 'EACCES' })
    return payload as never
  })
  vi.mocked(fs.stat).mockImplementation(async path => {
    expect([directory, `/proc/${pid}`]).toContain(path)
    return object(changed === 'reused' && afterRead ? 101n : 100n,
      changed === 'owner' && afterRead ? BigInt(process.getuid!()) + 1n : BigInt(process.getuid!())) as never
  })
})
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks() })

it('reads only the original pinned Linux process environment and keeps its NUL-delimited values intact', async () => {
  expect(await nativeProcessEnvironment(pid, AbortSignal.timeout(1000))).toEqual({ HOME: '/original', DAEMON_ONLY_AUTH_CONTEXT: 'extra',
    UNICODE: '权限🔒', MULTILINE: 'a\nb=c', EMPTY: '' })
  expect(vi.mocked(fs.readFile).mock.calls.filter(call => String(call[0]).endsWith('/environ')).map(call => call[0])).toEqual([directory + '/environ'])
  expect(close).toHaveBeenCalledTimes(1); expect(runProcess).not.toHaveBeenCalled(); expect(fs.readdir).not.toHaveBeenCalled()
})

it.each(['permission', 'reused', 'owner', 'exited'])('keeps a Linux %s observation unavailable and closes the original pinned object', async reason => {
  changed = reason
  await expect(nativeProcessEnvironment(pid, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE' })
  expect(close).toHaveBeenCalledTimes(1); expect(runProcess).not.toHaveBeenCalled()
})

it('does not expose malformed environment values in an error or silently choose a duplicate key', async () => {
  payload = Buffer.from('SECRET=private-fixture-secret\0SECRET=other-value\0')
  const result = await nativeProcessEnvironment(pid, AbortSignal.timeout(1000)).then(value => ({ value }), error => ({ error }))
  expect(result).toHaveProperty('error'); expect(JSON.stringify(result)).not.toContain('private-fixture-secret')
  expect(close).toHaveBeenCalledTimes(1)
})

it('retains cancellation while releasing the original Linux process object', async () => {
  const controller = new AbortController(), reason = new Error('original observation canceled')
  const read = vi.mocked(fs.readFile).getMockImplementation()!
  vi.mocked(fs.readFile).mockImplementation(async (path, options) => {
    const result = await read(path, options as never)
    if (String(path).endsWith('/environ')) controller.abort(reason)
    return result as never
  })
  await expect(nativeProcessEnvironment(pid, controller.signal)).rejects.toBe(reason)
  expect(close).toHaveBeenCalledTimes(1)
})
