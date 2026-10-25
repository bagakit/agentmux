import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('node:fs/promises', () => ({ open: vi.fn(), readFile: vi.fn(), readdir: vi.fn(), readlink: vi.fn(), stat: vi.fn() }))
vi.mock('../src/process-runner.js', () => ({ runProcess: vi.fn() }))
import * as fs from 'node:fs/promises'
import { runProcess } from '../src/process-runner.js'
import { linuxNativeProcessFiles } from '../src/agent-native-process-linux.js'
import { nativeProcessFiles } from '../src/agent-native-process.js'
const signal = () => new AbortController().signal
const statRecord = (pid: number, group = 101, start = '9911') =>
  `${pid} (native ) name (x)) ${['S', '1', String(group), '101', ...Array(15).fill('0'), start, '0', '0'].join(' ')}\n`
const object = (inode: bigint, file = true) => ({ dev: 65025n, ino: inode, mode: file ? 0o100600n : 0o40700n, isFile: () => file, isDirectory: () => !file })
const calls: string[] = [], closes: Array<ReturnType<typeof vi.fn>> = []
const opened = new Map<number, number>()
let members: number[], groupReads: number, stats: number, fds: string[], directoryInode: bigint
const lookup = (input: unknown) => {
  const path = String(input); calls.push(path)
  const match = /^\/proc\/self\/fd\/(\d+)(.*)$/u.exec(path)
  if (!match || !opened.has(Number(match[1]))) throw new Error('Unpinned or unrelated proc read: ' + path)
  return { pid: opened.get(Number(match[1]))!, suffix: match[2]! }
}
beforeEach(() => {
  calls.length = 0; closes.length = 0; opened.clear(); members = [101, 102]; groupReads = 0; stats = 0; fds = ['4', '0']; directoryInode = 9001n
  vi.mocked(runProcess).mockImplementation(async (command, args) => {
    expect([...opened.values()]).toContain(101); expect(command).toBe('pgrep'); expect(args).toEqual(['-g', '101']); groupReads++
    return { exitCode: 0, stdout: members.join('\n') + '\n', stderr: '' }
  })
  vi.mocked(fs.open).mockImplementation(async input => {
    const match = /^\/proc\/(101|102)$/u.exec(String(input)); if (!match) throw new Error('Unrelated process opened: ' + input)
    const fd = 800 + opened.size; opened.set(fd, Number(match[1])); const close = vi.fn(async () => {}); closes.push(close)
    return { fd, stat: async () => object(directoryInode, false), close } as unknown as fs.FileHandle
  })
  vi.mocked(fs.readFile).mockImplementation(async input => {
    const { pid, suffix } = lookup(input)
    if (suffix === '/stat') { stats++; return statRecord(pid) as never }
    if (suffix === '/fdinfo/4') return 'pos:\t100\nflags:\t02100002\nmnt_id:\t25\nino:\t1868522\n' as never
    throw new Error('Unexpected metadata: ' + suffix)
  })
  vi.mocked(fs.readdir).mockImplementation(async input => { expect(lookup(input).suffix).toBe('/fd'); return [...fds] as never })
  vi.mocked(fs.stat).mockImplementation(async input => { const { suffix } = lookup(input); return object(suffix === '/exe' ? 8000n : suffix === '/fd/0' ? 55n : 1868522n, suffix !== '/fd/0') as never })
  vi.mocked(fs.readlink).mockImplementation(async input => lookup(input).suffix === '/exe' ? '/usr/bin/native-agent' : '/work/rollout-original.jsonl')
})
afterEach(() => vi.resetAllMocks())
it('reads only pinned original group objects, preserves big-integer file facts and never calls lsof or scans mounts/process directories', async () => {
  const operation = linuxNativeProcessFiles(101, signal(), 'run-group')
  await expect(operation).resolves.toHaveLength(2)
  const files = await operation
  expect(files).toEqual([101, 102].map(processId => ({ processId, processGroup: 101, descriptor: '4', path: '/work/rollout-original.jsonl', device: 65025n, inode: 1868522n, access: 'u' })))
  expect(groupReads).toBe(2); expect(stats).toBe(4)
  expect(opened.size).toBe(2); expect(closes.every(close => close.mock.calls.length === 1)).toBe(true)
  expect(calls.every(path => path.startsWith('/proc/self/fd/'))).toBe(true)
})
it('the public nativeProcessFiles Linux branch consumes the direct observation', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  try { Object.defineProperty(process, 'platform', { value: 'linux' }); expect(await nativeProcessFiles(101, signal())).toHaveLength(2) }
  finally { Object.defineProperty(process, 'platform', platform) }
})
it('process scope preserves its actual group and executable object without querying other processes', async () => {
  const files = await linuxNativeProcessFiles(102, signal(), 'process')
  expect(runProcess).not.toHaveBeenCalled()
  expect(files).toEqual([
    { processId: 102, processGroup: 101, descriptor: '4', path: '/work/rollout-original.jsonl', device: 65025n, inode: 1868522n, access: 'u' },
    { processId: 102, processGroup: 101, descriptor: 'txt', path: '/usr/bin/native-agent', device: 65025n, inode: 8000n }
  ])
})
it.each(['permission', 'member-vanished', 'pid-reused', 'group-changed', 'members-changed', 'descriptor-set-changed', 'descriptor-object-changed', 'descriptor-info-changed', 'directory-object-changed'])('keeps %s as typed unknown and closes every acquired proc directory', async change => {
  const read = vi.mocked(fs.readFile).getMockImplementation()!, fileStat = vi.mocked(fs.stat).getMockImplementation()!, list = vi.mocked(fs.readdir).getMockImplementation()!
  if (change === 'permission') vi.mocked(fs.readdir).mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }))
  if (change === 'member-vanished') vi.mocked(fs.open).mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'ENOENT' }))
  if (['pid-reused', 'group-changed'].includes(change)) vi.mocked(fs.readFile).mockImplementation(async (input, options) => {
    if (String(input).endsWith('/stat') && stats >= 2) return statRecord(lookup(input).pid, change === 'group-changed' ? 999 : 101, change === 'pid-reused' ? '9922' : '9911') as never
    return read(input, options as never) as never
  })
  if (change === 'members-changed') vi.mocked(runProcess).mockResolvedValueOnce({ exitCode: 0, stdout: '101\n102\n', stderr: '' }).mockResolvedValueOnce({ exitCode: 0, stdout: '101\n', stderr: '' })
  if (change === 'descriptor-set-changed') { let count = 0; vi.mocked(fs.readdir).mockImplementation(async (...args) => { if (++count === 2) fds = ['0']; return list(...args) as never }) }
  if (change === 'descriptor-object-changed') { let count = 0; vi.mocked(fs.stat).mockImplementation(async (...args) => String(args[0]).endsWith('/fd/4') && ++count === 2 ? object(9999n) as never : fileStat(...args) as never) }
  if (change === 'descriptor-info-changed') { let count = 0; vi.mocked(fs.readFile).mockImplementation(async (input, options) => String(input).endsWith('/fdinfo/4') && ++count === 2 ? 'flags:\t02100002\nino:\t123\n' as never : read(input, options as never) as never) }
  if (change === 'directory-object-changed') vi.mocked(fs.readFile).mockImplementation(async (input, options) => { if (stats >= 2) directoryInode = 9002n; return read(input, options as never) as never })
  await expect(linuxNativeProcessFiles(101, signal(), 'run-group')).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE' })
  expect(closes.every(close => close.mock.calls.length === 1)).toBe(true)
})
it.each(['ino:\t1\nflags:\t02000000\n', 'ino:\t1868522\n', 'ino:\t1868522\nflags:\tbad\n', 'ino:\t1868522\nflags:\t02000000\nflags:\t02000000\n'])('rejects incomplete or mismatched descriptor metadata %s', async metadata => {
  const read = vi.mocked(fs.readFile).getMockImplementation()!
  vi.mocked(fs.readFile).mockImplementation(async (input, options) => String(input).includes('/fdinfo/') ? metadata as never : read(input, options as never) as never)
  await expect(linuxNativeProcessFiles(101, signal(), 'run-group')).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE' })
})
it('retains cancellation and releases the original proc object without returning partial files', async () => {
  const controller = new AbortController(), reason = new Error('original cancelled')
  vi.mocked(fs.readdir).mockImplementationOnce(async () => { controller.abort(reason); return ['4'] as never })
  await expect(linuxNativeProcessFiles(101, controller.signal, 'run-group')).rejects.toBe(reason)
  expect(closes.every(close => close.mock.calls.length === 1)).toBe(true)
})

it('keeps an exited pinned proc object unavailable even if its numeric PID could be reused', async () => {
  const read = vi.mocked(fs.readFile).getMockImplementation()!
  vi.mocked(fs.readFile).mockImplementation(async (input, options) => {
    if (String(input).endsWith('/stat') && stats >= 2) throw Object.assign(new Error('original proc object exited'), { code: 'ESRCH' })
    return read(input, options as never) as never
  })
  await expect(linuxNativeProcessFiles(101, signal(), 'run-group')).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE' })
  expect(calls.every(path => path.startsWith('/proc/self/fd/'))).toBe(true)
})
it.each(['missing', 'nonzero', 'stderr', 'incomplete'])('preserves %s group observation as typed unknown', async condition => {
  if (condition === 'missing') vi.mocked(runProcess).mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }))
  else vi.mocked(runProcess).mockResolvedValueOnce({ exitCode: condition === 'nonzero' ? 1 : 0,
    stdout: condition === 'incomplete' ? '102\n' : '101\n102\n', stderr: condition === 'stderr' ? 'unavailable' : '' })
  await expect(linuxNativeProcessFiles(101, signal(), 'run-group')).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE' })
})
it('close failure does not replace the original observation diagnostic or cancellation', async () => {
  vi.mocked(fs.readdir).mockImplementationOnce(async () => {
    closes[0]!.mockRejectedValueOnce(new Error('close failure'))
    throw Object.assign(new Error('denied'), { code: 'EACCES' })
  })
  await expect(linuxNativeProcessFiles(101, signal(), 'run-group')).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE' })
  expect(closes.every(close => close.mock.calls.length === 1)).toBe(true)
})
it('keeps the existing macOS exact group lsof protocol unchanged', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  vi.mocked(runProcess).mockReset().mockResolvedValueOnce({ exitCode: 0, stdout: '101\n', stderr: '' })
    .mockResolvedValueOnce({ exitCode: 0, stdout: 'p102\0g101\0\nf4\0tREG\0n/work/rollout-original.jsonl\0Dfe01\0i1868522\0au\0\n', stderr: '' })
  try {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    expect(await nativeProcessFiles(101, signal())).toEqual([{ processId: 102, processGroup: 101, descriptor: '4',
      path: '/work/rollout-original.jsonl', device: 65025n, inode: 1868522n, access: 'u' }])
    expect(vi.mocked(runProcess).mock.calls.map(call => call.slice(0, 2))).toEqual([
      ['ps', ['-p', '101', '-o', 'pgid=']], ['lsof', ['-nP', '-a', '-g', '101', '-F0pgftnDia']]])
    expect(fs.open).not.toHaveBeenCalled()
  } finally { Object.defineProperty(process, 'platform', platform) }
})
