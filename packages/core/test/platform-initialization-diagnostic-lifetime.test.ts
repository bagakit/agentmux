import { afterEach, expect, it, vi } from 'vitest'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { captureExecutorInvocation } from '../src/agent-executor-invocation.js'
import type { AgentProviderInputInitialization } from '../src/agent-provider.js'

const closes: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

async function original(command: string | ((root: string) => Promise<string>) = 'grok') {
  const f = await rpcOwnerFixture(['recipient', 'neighbor'], undefined, () => ({ providerId: 'grok', executorId: 'grok' })); closes.push(f.close)
  const executable = typeof command === 'string' ? command : await command(f.root)
  const inner = f.client as any, run = { runId: 'run-recipient' }
  const source = captureExecutorInvocation('grok', 'grok', 'original-create', 'b'.repeat(64), { commandOverride: executable, env: { HOME: f.root, GROK_HOME: f.root } })!
  const before = (await f.store.readMetadata('recipient'))!
  await f.store.compareAndSwapMetadata(before, { ...before, creation: { createOperationId: 'original-create', createdRun: run,
    initialPrompt: 'not-requested', intentDigest: 'b'.repeat(64), executorInvocationDigest: source.digest }, executorInvocation: source.value })
  await inner.registry.refresh('recipient', run)
  inner.kernel.status = vi.fn(async (id: string) => ({ ...f.run(id), pid: 1234, program: executable }))
  const key = { kind: 'prompt' as const, agentSessionId: 'recipient', expectedRun: run, submissionId: 'original-diagnostic-Q' }
  const ready = () => inner.acceptHookEvent({ agentSessionId: 'recipient', providerId: 'grok', runId: run.runId, receiptId: 'original-start-ready',
    eventName: 'session_start', payload: { hookEventName: 'session_start', sessionId: 'original-native', cwd: f.root } }, AbortSignal.timeout(5000))
  const submit = () => f.client.submitAgentPrompt({ agentSessionId: key.agentSessionId, expectedRun: run, operationId: key.submissionId,
    prompt: 'Original Q must not wait for diagnostics', admissionIntent: { kind: 'session-conversation' }, execution: 'immediate', authorHuman: true })
  return { ...f, inner, key, ready, submit }
}

it('current native qualification releases an uncooperative optional diagnostic and late results cannot overwrite the same admitted input', async () => {
  const f = await original(), provider = f.client.providers.get('grok')
  let release!: (value: AgentProviderInputInitialization) => void, signal: AbortSignal | undefined
  const pending = new Promise<AgentProviderInputInitialization>(yes => { release = yes })
  const read = vi.fn(async context => { signal = context.signal; return await pending })
  f.client.providers.replace({ ...provider, readInputInitialization: read })
  await f.submit(); await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
  const held = (await f.client.inspectAgentInput({ key: f.key }))!
  await f.client.rejoinAgentInputWaiting({ ref: held.ref })
  f.inner.publishSession(f.inner.registry.get('neighbor'))
  expect(signal?.aborted).toBe(false); expect(f.inner.kernel.input).not.toHaveBeenCalled()
  await f.ready()
  await vi.waitFor(async () => expect((await f.client.inspectAgentInput({ key: f.key }))?.status).toBe('terminal-confirmed'), { timeout: 5000 })
  expect(signal?.aborted).toBe(true); expect(f.inner.kernel.input).toHaveBeenCalledTimes(1)
  const before = structuredClone((await f.client.inspectAgentInput({ key: f.key }))!.admission)
  release({ state: 'pending', reason: 'directory-trust' }); await pending; await Promise.resolve()
  expect((await f.client.inspectAgentInput({ key: f.key }))!.admission).toEqual(before)
  expect((await f.client.inspectAgentInput({ key: f.key }))!.status).toBe('terminal-confirmed')
  expect(read).toHaveBeenCalledTimes(1); expect(f.inner.kernel.input).toHaveBeenCalledTimes(1); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('a real hanging native inspect child is cancelled on original qualification without stopping the Agent', async () => {
  let pidFile = ''
  const f = await original(async root => {
    const command = join(root, 'native-inspect'); pidFile = join(root, 'diagnostic.pid')
    await writeFile(command, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);\n`)
    await chmod(command, 0o700)
    return command
  })
  await f.submit()
  let pid = 0
  await vi.waitFor(async () => { pid = Number(await readFile(pidFile, 'utf8')); expect(pid).toBeGreaterThan(0) }, { timeout: 5000 })
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  await f.ready()
  await vi.waitFor(async () => expect((await f.client.inspectAgentInput({ key: f.key }))?.status).toBe('terminal-confirmed'), { timeout: 5000 })
  await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5000 })
  expect(f.inner.kernel.input).toHaveBeenCalledTimes(1); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})
