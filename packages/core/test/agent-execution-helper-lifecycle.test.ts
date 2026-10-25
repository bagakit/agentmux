import { fileURLToPath } from 'node:url'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAgentExecutionHelperCli } from '../src/agent-execution-helper-run.js'

const originalArgv = process.argv
afterEach(() => { process.argv = originalArgv; vi.doUnmock('../src/agent-execution-helper-run.js'); vi.restoreAllMocks(); vi.resetModules() })

function signals() {
  const handlers = new Map<string, () => void>()
  const on = process.on.bind(process), remove = process.removeListener.bind(process)
  vi.spyOn(process, 'on').mockImplementation((event, listener) => {
    if (typeof event === 'string' && ['SIGTERM', 'SIGHUP', 'SIGINT'].includes(event)) handlers.set(event, listener as () => void)
    else on(event, listener)
    return process
  })
  vi.spyOn(process, 'removeListener').mockImplementation((event, listener) => {
    if (typeof event === 'string' && handlers.get(event) === listener) handlers.delete(event)
    else remove(event, listener)
    return process
  })
  return handlers
}

describe('explicit execution helper CLI ownership', () => {
  it('retains a startup signal and closes the original returned handle exactly once', async () => {
    const handlers = signals(), close = vi.fn(async () => {})
    let ready!: (handle: { close(): Promise<void> }) => void
    const finish = runAgentExecutionHelperCli(() => new Promise(resolve => { ready = resolve }))
    handlers.get('SIGTERM')!(); handlers.get('SIGHUP')!()
    expect(close).not.toHaveBeenCalled()
    ready({ close }); await finish
    expect(close).toHaveBeenCalledTimes(1)
    expect(handlers.size).toBe(0)
  })

  it('awaits the actual close receipt without retrying it on another signal', async () => {
    const handlers = signals()
    let closed!: () => void, finished = false
    const close = vi.fn(() => new Promise<void>(resolve => { closed = resolve }))
    const finish = runAgentExecutionHelperCli(async () => ({ close })).then(() => { finished = true })
    handlers.get('SIGINT')!()
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1))
    handlers.get('SIGTERM')!()
    expect(finished).toBe(false)
    closed(); await finish
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('preserves a failed close as a failure and releases its signal listeners', async () => {
    const handlers = signals(), failure = new Error('Original close failed')
    const finish = runAgentExecutionHelperCli(async () => ({ close: async () => { throw failure } }))
    handlers.get('SIGHUP')!()
    await expect(finish).rejects.toBe(failure)
    expect(handlers.size).toBe(0)
  })

  it('releases its listeners when the original startup fails', async () => {
    const handlers = signals(), failure = new Error('Original start failed')
    await expect(runAgentExecutionHelperCli(async () => { throw failure })).rejects.toBe(failure)
    expect(handlers.size).toBe(0)
  })

  for (const provider of ['claude', 'codex'] as const) {
    async function entry(close: () => Promise<void>) {
      const handlers = signals(), input = new PassThrough()
      vi.spyOn(process, 'stdin', 'get').mockReturnValue(input as NodeJS.ReadStream)
      const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
      const diagnostics: string[] = []
      vi.spyOn(process.stdout, 'write').mockImplementation(((data: string | Uint8Array, encoding?: unknown, callback?: () => void) => {
        diagnostics.push(String(data)); (typeof encoding === 'function' ? encoding as () => void : callback)?.(); return true
      }) as typeof process.stdout.write)
      const run = vi.fn(async () => ({ close }))
      vi.doMock('../src/agent-execution-helper-run.js', async () => ({ ...await vi.importActual<typeof import('../src/agent-execution-helper-run.js')>('../src/agent-execution-helper-run.js'), runAgentExecutionHelper: run }))
      process.argv = [process.execPath, fileURLToPath(new URL(`../src/providers/${provider}-execution-run.ts`, import.meta.url)), '--agentmux-execution-helper', JSON.stringify({
        providerId: provider, role: 'frontend', bindingId: 'original-binding', createOperationId: 'original-creation', agentSessionId: 'original-session',
        workspacePath: '/original/workspace', journalDirectory: '/original/journal', executable: '/original/cli',
      })]
      if (provider === 'claude') await import('../src/providers/claude-execution-run.js')
      else await import('../src/providers/codex-execution-run.js')
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
      return { handlers, input, exit, diagnostics }
    }

    it(`${provider} CLI keeps its handle across EOF and closes it before explicit shutdown exits`, async () => {
      let closed!: () => void
      const close = vi.fn(() => new Promise<void>(resolve => { closed = resolve }))
      const value = await entry(close)
      value.input.end(); await new Promise(resolve => setImmediate(resolve))
      expect(close).not.toHaveBeenCalled(); expect(value.exit).not.toHaveBeenCalled()
      expect(value.handlers.has('SIGTERM')).toBe(true)
      value.handlers.get('SIGTERM')!()
      await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1))
      expect(value.exit).not.toHaveBeenCalled()
      closed(); await vi.waitFor(() => expect(value.exit).toHaveBeenCalledWith(0))
      expect(value.handlers.size).toBe(0)
    })

    it(`${provider} CLI reports failed explicit shutdown and exits unsuccessfully`, async () => {
      const close = vi.fn(async () => { throw new Error('Original close failed') })
      const value = await entry(close)
      value.handlers.get('SIGTERM')!()
      await vi.waitFor(() => expect(value.exit).toHaveBeenCalledWith(1))
      expect(value.exit).not.toHaveBeenCalledWith(0)
      expect(value.diagnostics.map(line => JSON.parse(line))).toEqual([{ type: 'diagnostic', scope: 'helper', code: 'NATIVE_EXECUTION_HELPER_LIFECYCLE_FAILED' }])
    })
  }
})
