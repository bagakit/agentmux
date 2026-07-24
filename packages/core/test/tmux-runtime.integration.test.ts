import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalExecutionHost } from '../src/execution-host.js'
import { AgentMuxRuntime } from '../src/runtime.js'

const runtimes: AgentMuxRuntime[] = []

async function waitFor<T>(read: () => Promise<T> | T, accept: (value: T) => boolean, timeoutMs = 8_000): Promise<T> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const value = await read()
    if (accept(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  throw new Error(`Timed out after ${timeoutMs}ms`)
}

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    for (const session of runtime.snapshot().sessions) await runtime.stopSession(session.id).catch(() => {})
    await runtime.dispose()
  }
})

describe('real tmux runtime', () => {
  it('launches, captures output, sends input, observes exit, and cleans up', async () => {
    const runtime = new AgentMuxRuntime({
      hosts: [new LocalExecutionHost()],
      pollIntervalMs: 100
    })
    runtimes.push(runtime)
    const id = `test-${randomUUID().slice(0, 8)}`
    await runtime.launch({
      kind: 'agent',
      sessionId: id,
      agentId: 'codex',
      workspacePath: process.cwd(),
      commandOverride: process.execPath,
      args: [
        '-e',
        "const readline=require('node:readline'); console.log('READY'); const rl=readline.createInterface({input:process.stdin}); rl.on('line',line=>{console.log('ECHO:'+line); if(line==='quit') process.exit(7)})"
      ]
    })

    await waitFor(() => runtime.capture(id), (output) => output.includes('READY'))
    await runtime.send(id, 'hello')
    await waitFor(() => runtime.capture(id), (output) => output.includes('ECHO:hello'))
    await runtime.send(id, 'quit')
    const exited = await waitFor(
      () => runtime.snapshot().sessions.find((item) => item.id === id),
      (value) => value?.processState === 'exited'
    )
    expect(exited?.status).toMatchObject({ state: 'exited', source: 'tmux', exitCode: 7 })

    await runtime.stopSession(id)
    expect(runtime.snapshot().sessions).toHaveLength(0)
  })

  it('launches a raw terminal in the host default shell', async () => {
    const runtime = new AgentMuxRuntime({ hosts: [new LocalExecutionHost()], pollIntervalMs: 100 })
    runtimes.push(runtime)
    const id = `terminal-${randomUUID().slice(0, 8)}`

    const launched = await runtime.launch({
      kind: 'terminal',
      sessionId: id,
      workspacePath: process.cwd()
    })

    expect(launched).toMatchObject({ kind: 'terminal', agentId: null, processState: 'running' })
    await runtime.send(id, "printf 'RAW_TERMINAL_OK\\n'")
    await waitFor(() => runtime.capture(id), (output) => output.includes('RAW_TERMINAL_OK'))

    const typedCommand = "printf 'ORDERED_INPUT_OK\\n'\r"
    await Promise.all([...typedCommand].map(async (character) => await runtime.send(id, character, false)))
    await waitFor(() => runtime.capture(id), (output) => output.includes('ORDERED_INPUT_OK'))
  })
})
