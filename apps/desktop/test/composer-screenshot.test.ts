import { EventEmitter } from 'node:events'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ spawn: vi.fn(), mkdir: vi.fn(), stat: vi.fn(), rm: vi.fn(), access: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: native.spawn }))
vi.mock('node:fs/promises', () => ({ mkdir: native.mkdir, stat: native.stat, rm: native.rm }))
vi.mock('electron', () => ({ systemPreferences: { getMediaAccessStatus: native.access } }))

class CaptureChild extends EventEmitter {
  stderr = new EventEmitter()
  kill = vi.fn((_signal: string) => true)
}
let capture: typeof import('../src/main/composer-screenshot')['captureComposerScreenshot']
let child: CaptureChild
beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  native.mkdir.mockReset().mockResolvedValue(undefined)
  native.stat.mockReset().mockResolvedValue({ size: 12, isFile: () => true })
  native.rm.mockReset().mockResolvedValue(undefined)
  native.access.mockReset().mockReturnValue('granted')
  child = new CaptureChild()
  native.spawn.mockReset().mockReturnValue(child)
  capture = (await import('../src/main/composer-screenshot')).captureComposerScreenshot
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
async function started() {
  const request = capture('/home')
  await Promise.resolve()
  return { request }
}
const noFile = () => native.stat.mockRejectedValue(Object.assign(new Error('No file'), { code: 'ENOENT' }))
async function remainsBusy(home = '/home') {
  const directories = native.mkdir.mock.calls.length
  const children = native.spawn.mock.calls.length
  const attempt = capture(home).catch((error: Error) => error)
  await Promise.resolve()
  expect(native.mkdir).toHaveBeenCalledTimes(directories)
  expect(native.spawn).toHaveBeenCalledTimes(children)
  const error = await attempt
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toMatch(/already|in progress|busy/i)
}

it('owns the capture before mkdir resolves and never joins a second Composer to its result', async () => {
  let directory!: () => void
  native.mkdir.mockImplementationOnce(() => new Promise<void>((resolve) => { directory = resolve }))
  const first = capture('/home')
  expect(native.mkdir).toHaveBeenCalledTimes(1)
  await remainsBusy('/other-home')
  expect(native.spawn).toHaveBeenCalledTimes(0)
  directory()
  await Promise.resolve()
  expect(native.spawn).toHaveBeenCalledTimes(1)
  expect(native.spawn.mock.calls[0]).toEqual(['/usr/sbin/screencapture', ['-i', '-x', '-t', 'png', expect.stringMatching(/^\/home\/\.agentmux\/pasted\/screen-.+\.png$/)], { stdio: ['ignore', 'ignore', 'pipe'] }])
  child.emit('close', 0, null)
  const saved = await first
  expect(saved).toBe(native.spawn.mock.calls[0]![1][4])
  expect(native.access).toHaveBeenCalledTimes(0)
})
it('keeps ownership while saved-file verification after close is still pending', async () => {
  let inspected!: (value: { size: number; isFile(): boolean }) => void
  native.stat.mockImplementationOnce(() => new Promise((resolve) => { inspected = resolve }))
  const { request } = await started()
  child.emit('close', 0, null)
  await remainsBusy()
  inspected({ size: 12, isFile: () => true })
  expect(await request).toBe(native.spawn.mock.calls[0]![1][4])
  const next = await started()
  expect(native.spawn).toHaveBeenCalledTimes(2)
  child.emit('close', 0, null)
  await next.request
})
it.each(['mkdir', 'spawn'] as const)('a %s failure before a child exists releases ownership for an explicit retry', async (step) => {
  if (step === 'mkdir') native.mkdir.mockRejectedValueOnce(new Error('Directory unavailable'))
  else native.spawn.mockImplementationOnce(() => { throw new Error('Spawn unavailable') })
  await expect(capture('/home')).rejects.toThrow(step === 'mkdir' ? /Directory unavailable/ : /Spawn unavailable/)
  const { request } = await started()
  child.emit('close', 0, null)
  expect(await request).toBe(native.spawn.mock.calls.at(-1)![1][4])
})
it('a child error is not exit evidence; even repeated kill errors retain the owner until close', async () => {
  const { request } = await started()
  const failure = expect(request).rejects.toThrow(/failed|unavailable/i)
  child.emit('error', new Error('Child unavailable'))
  expect(() => child.emit('error', new Error('SIGTERM unavailable'))).not.toThrow()
  await remainsBusy()
  expect(native.spawn).toHaveBeenCalledTimes(1)
  expect(child.listenerCount('error')).toBeGreaterThan(0)
  child.emit('close', 0, null)
  await failure
  expect(native.rm).toHaveBeenCalledTimes(1)
  const next = await started()
  expect(native.spawn).toHaveBeenCalledTimes(2)
  child.emit('close', 0, null)
  await next.request
})
it('retains the first child error and the actual null-code signal close as separate facts', async () => {
  const { request } = await started()
  const failure = request.catch((error: Error) => error)
  child.emit('error', new Error('Child unavailable'))
  await remainsBusy()
  child.emit('close', null, 'SIGTERM')
  const error = await failure
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toContain('The screen selector failed: Child unavailable.')
  expect((error as Error).message).toContain('Actual close: code null, signal SIGTERM.')
  expect(native.stat).toHaveBeenCalledTimes(0)
  expect(native.rm).toHaveBeenCalledTimes(1)
  const next = await started()
  expect(native.spawn).toHaveBeenCalledTimes(2)
  child.emit('close', 0, null)
  await next.request
})
it('retains timeout and the actual late successful close without returning its image', async () => {
  const { request } = await started()
  const failure = request.catch((error: Error) => error)
  await vi.advanceTimersByTimeAsync(120_000)
  expect(child.kill.mock.calls).toEqual([['SIGTERM']])
  await remainsBusy()
  child.emit('close', 0, null)
  const error = await failure
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toContain('The screen selector timed out.')
  expect((error as Error).message).toContain('Actual close: code 0, signal null.')
  expect(native.stat).toHaveBeenCalledTimes(0)
  expect(native.rm).toHaveBeenCalledTimes(1)
})
it('timeout requests TERM then KILL once, returns finite unknown without close and releases only after a late close', async () => {
  const { request } = await started()
  const failure = expect(request).rejects.toThrow(/cannot confirm.*exited/i)
  await vi.advanceTimersByTimeAsync(120_000)
  expect(child.kill.mock.calls).toEqual([['SIGTERM']])
  await remainsBusy()
  await vi.advanceTimersByTimeAsync(1_000)
  expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
  await vi.advanceTimersByTimeAsync(1_000)
  await failure
  expect(native.rm).toHaveBeenCalledTimes(0)
  await remainsBusy()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
  expect(native.spawn).toHaveBeenCalledTimes(1)
  child.emit('close', 0, null)
  await Promise.resolve()
  await Promise.resolve()
  const retry = await started()
  expect(native.spawn).toHaveBeenCalledTimes(2)
  child.emit('close', 0, null)
  await retry.request
})
it.each(['false', 'throw', 'error'] as const)('kill %s does not unlock the selector or make a timeout successful', async (failureMode) => {
  child.kill.mockImplementation(() => {
    if (failureMode === 'throw') throw new Error('Kill unavailable')
    if (failureMode === 'error') child.emit('error', new Error('Kill unavailable'))
    return false
  })
  const { request } = await started()
  const failure = expect(request).rejects.toThrow(/timed out/i)
  await vi.advanceTimersByTimeAsync(121_000)
  expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
  await remainsBusy()
  child.emit('close', 0, null)
  await failure
  expect(native.rm).toHaveBeenCalledTimes(1)
  expect(native.stat).toHaveBeenCalledTimes(0)
})
it.each(['granted', 'denied', 'restricted', 'unknown', 'throw'])('screen readout %s never precedes or blocks a successful capture', async (readout) => {
  native.access.mockImplementation(() => { if (readout === 'throw') throw new Error('Readout unavailable'); return readout })
  const { request } = await started()
  expect(native.spawn).toHaveBeenCalledTimes(1)
  child.emit('close', 0, null)
  expect(await request).toBe(native.spawn.mock.calls[0]![1][4])
  expect(native.access).toHaveBeenCalledTimes(0)
})
it.each([
  ['quiet no file', 0, null, '', 'missing', /no image.*cannot confirm.*cancel/i],
  ['nonzero no stderr', 1, null, '', 'missing', /exit code 1/i],
  ['busy', 1, null, 'cannot run two interactive screen captures at a time', 'missing', /cannot run two/i],
  ['signal', null, 'SIGTERM', '', 'missing', /signal SIGTERM/i],
  ['null code', null, null, '', 'missing', /no exit code/i],
  ['empty file', 0, null, '', 'empty', /empty/i],
  ['not a file', 0, null, '', 'directory', /regular file/i],
  ['save read failure', 0, null, '', 'access', /inspect.*EACCES/i]
] as const)('%s is an accurate failure rather than fabricated cancellation', async (_name, code, signal, stderr, output, reason) => {
  if (output === 'missing') noFile()
  else if (output === 'empty') native.stat.mockResolvedValue({ size: 0, isFile: () => true })
  else if (output === 'directory') native.stat.mockResolvedValue({ size: 12, isFile: () => false })
  else native.stat.mockRejectedValue(Object.assign(new Error('EACCES save read'), { code: 'EACCES' }))
  const { request } = await started()
  const failure = expect(request).rejects.toThrow(reason)
  if (stderr) child.stderr.emit('data', Buffer.from(stderr))
  child.emit('close', code, signal)
  await failure
  expect(native.rm).toHaveBeenCalledTimes(1)
})
it('permission diagnostics stay factual and do not rename a save failure as denied permission', async () => {
  native.access.mockReturnValue('denied')
  native.stat.mockRejectedValue(new Error('Disk unreadable'))
  const { request } = await started()
  const failure = expect(request).rejects.toThrow(/inspect.*Disk unreadable.*screen access.*denied.*does not establish/i)
  expect(native.access).toHaveBeenCalledTimes(0)
  child.emit('close', 0, null)
  await failure
  expect(native.access).toHaveBeenCalledWith('screen')
})
it('diagnostic read failure is unknown, retains the command failure and offers an explicit retry', async () => {
  native.access.mockImplementation(() => { throw new Error('Readout unavailable') })
  const { request } = await started()
  const failure = expect(request).rejects.toThrow(/exit code 2.*screen access.*unknown.*try again/i)
  child.emit('close', 2, null)
  await failure
})
it('partial cleanup failure does not erase the command failure', async () => {
  native.rm.mockRejectedValue(new Error('Cleanup unavailable'))
  const { request } = await started()
  const failure = expect(request).rejects.toThrow(/exit code 3.*Cleanup unavailable/i)
  child.emit('close', 3, null)
  await failure
})
it('stderr remains bounded and is consumed after failure without an unbounded error buffer', async () => {
  const { request } = await started()
  const failure = request.catch((error: Error) => error)
  child.stderr.emit('data', Buffer.alloc(100_000, 'x'))
  child.emit('close', 1, null)
  const error = await failure
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message.length).toBeLessThan(17_000)
  expect((error as Error).message).toContain('exit code 1')
})
