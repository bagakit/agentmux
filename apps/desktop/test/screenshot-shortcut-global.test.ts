import { afterEach, expect, it, vi } from 'vitest'
import { GlobalScreenshot } from '../src/main/global-screenshot'
const identity = { windowId: 'original-window', documentGeneration: 'original-document' }
afterEach(() => vi.useRealTimers())
function fixture() {
  const nativeWindow = { isDestroyed: () => false, isFocused: vi.fn(() => true), isMinimized: vi.fn(() => false) }
  const frame = { executeJavaScript: vi.fn(async (code: string) => code.includes('?.prepare(') ? identity : undefined) }
  const contents = { isDestroyed: vi.fn(() => false), mainFrame: frame }
  const focusedWindow = vi.fn(() => nativeWindow), windowForDocument = vi.fn(() => nativeWindow)
  const capture = vi.fn(async (_attach: boolean): Promise<string | null> => 'original.png'), reportIssue = vi.fn()
  const action = new GlobalScreenshot({ contents, focusedWindow, windowForDocument, capture, reportIssue } as never)
  return { action, frame, contents, nativeWindow, focusedWindow, windowForDocument, capture, reportIssue }
}

it('captures with no Renderer or workbench and treats attachment as optional', async () => {
  const f = fixture(); f.contents.isDestroyed.mockReturnValue(true)
  await f.action.run()
  expect(f.capture).toHaveBeenCalledExactlyOnceWith(false)
  expect(f.frame.executeJavaScript).not.toHaveBeenCalled()
})

it('uses a focused exact window and original frame, then sends one original operation result', async () => {
  const f = fixture()
  await f.action.run()
  expect(f.windowForDocument).toHaveBeenCalledExactlyOnceWith(identity)
  expect(f.capture).toHaveBeenCalledExactlyOnceWith(true)
  expect(f.frame.executeJavaScript).toHaveBeenCalledTimes(2)
  const prepared = f.frame.executeJavaScript.mock.calls[0]![0].match(/prepare\("([^"]+)"\)/)![1]
  expect(f.frame.executeJavaScript.mock.calls[1]![0]).toContain(`complete("${prepared}", "original.png")`)
  expect(f.reportIssue).not.toHaveBeenCalled()
})

it('rejects a stale native focus candidate while continuing clipboard capture', async () => {
  const f = fixture()
  f.windowForDocument.mockReturnValue({ ...f.nativeWindow } as never)
  await f.action.run()
  expect(f.capture).toHaveBeenCalledExactlyOnceWith(false)
  expect(f.frame.executeJavaScript.mock.calls[1]![0]).toContain(', null)')
})

it('a failed focus observation never closes the independent screen capture path', async () => {
  const f = fixture()
  f.frame.executeJavaScript.mockRejectedValueOnce(new Error('Original workbench observation unavailable'))
  await f.action.run()
  expect(f.capture).toHaveBeenCalledExactlyOnceWith(false)
  expect(f.reportIssue).toHaveBeenCalledOnce()
})

it('a synchronous detached-frame observation cannot block the healthy screenshot path', async () => {
  const f = fixture()
  f.frame.executeJavaScript.mockImplementationOnce(() => { throw new Error('Original frame detached') })
  await f.action.run()
  expect(f.capture).toHaveBeenCalledExactlyOnceWith(false)
})

it('an unavailable attachment receipt cannot hold later clipboard captures', async () => {
  vi.useFakeTimers()
  const f = fixture()
  f.frame.executeJavaScript.mockImplementationOnce(async () => identity).mockImplementationOnce(() => new Promise(() => {}))
  const first = f.action.run()
  await vi.advanceTimersByTimeAsync(501); await first
  expect(f.reportIssue).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('still unconfirmed') }))
  f.contents.isDestroyed.mockReturnValue(true)
  await f.action.run()
  expect(f.capture).toHaveBeenCalledTimes(2)
})

it('a preparation timeout captures now and only releases a late draft preparation', async () => {
  vi.useFakeTimers()
  const f = fixture()
  let respond!: (value: typeof identity) => void
  f.frame.executeJavaScript.mockImplementationOnce(() => new Promise(resolve => { respond = resolve }))
  const pending = f.action.run()
  await vi.advanceTimersByTimeAsync(251); await pending
  expect(f.capture).toHaveBeenCalledExactlyOnceWith(false)
  respond(identity); await Promise.resolve(); await Promise.resolve()
  expect(f.frame.executeJavaScript.mock.calls[1]![0]).toContain(', null)')
  expect(f.capture).toHaveBeenCalledOnce()
})

it('repeated pending hotkeys do not open another selection or repin a later draft', async () => {
  const f = fixture()
  let finish!: (value: string | null) => void
  f.capture.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const first = f.action.run(), repeated = f.action.run()
  expect(repeated).toBe(first)
  await vi.waitFor(() => expect(f.capture).toHaveBeenCalledOnce())
  finish('original.png'); await first
  expect(f.frame.executeJavaScript).toHaveBeenCalledTimes(2)
})

it('native unknown releases only the original attachment and preserves the failure', async () => {
  const f = fixture(), failure = new Error('Original native operation unknown')
  f.capture.mockRejectedValueOnce(failure)
  await expect(f.action.run()).rejects.toBe(failure)
  expect(f.frame.executeJavaScript.mock.calls[1]![0]).toContain(', null)')
  expect(f.capture).toHaveBeenCalledOnce()
})
