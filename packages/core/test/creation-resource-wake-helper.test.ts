import { getEventListeners } from 'node:events'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { retryAgentCreationResources as sourceRetry } from '../src/agent-creation-resource-retry.js'
import { AgentMuxError } from '../src/errors.js'

const sleeps = vi.hoisted(() => [] as Array<{ ms: number; finish(): void; signal: AbortSignal }>)
vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn((ms, _value, options) => new Promise<void>((yes, no) => {
  const signal: AbortSignal = options.signal
  const abort = () => { signal.removeEventListener('abort', abort); no(new Error('Test-owned timer aborted')) }
  sleeps.push({ ms, signal, finish: () => { signal.removeEventListener('abort', abort); yes() } })
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
})) }))
const compiled = process.env.AGENTMUX_TEST_CREATION_WAKE_ENTRY ? await import(/* @vite-ignore */ process.env.AGENTMUX_TEST_CREATION_WAKE_ENTRY) : undefined
const retry: typeof sourceRetry = compiled?.retryAgentCreationResources ?? sourceRetry
const Failure: typeof AgentMuxError = compiled?.AgentMuxError ?? AgentMuxError
const controllers: AbortController[] = [], cleaned: boolean[] = []
function cancellation() { const controller = new AbortController(); controllers.push(controller); return controller }
afterEach(async () => {
  for (const controller of controllers) controller.abort()
  await turn()
  const released = controllers.every(controller => getEventListeners(controller.signal, 'abort').length === 0)
  cleaned.push(released); controllers.splice(0); sleeps.splice(0); vi.clearAllMocks()
  expect(released).toBe(true)
})
afterAll(async () => {
  // This selected helper-only mutant has no executed Native test file/afterAll.
  if (process.env.AGENTMUX_TEST_CREATION_WAKE_MUTANT !== 'no-current-wait-release') return
  const cliModules: Record<string, string> = {}
  for (const file of JSON.parse(await readFile(process.env.AGENTMUX_TEST_CREATION_WAKE_CLI_MODULES!, 'utf8')))
    cliModules[basename(file)] = createHash('sha256').update(await readFile(file)).digest('hex')
  await writeFile(process.env.AGENTMUX_TEST_CREATION_WAKE_RESOURCES!, JSON.stringify({ resources: [], cliChildren: [], cleanupErrors: [],
    privateCleanup: cleaned.length > 0 && cleaned.every(Boolean), cliModules,
    cliSHA256: createHash('sha256').update(await readFile(process.env.AGENTMUX_TEST_CREATION_WAKE_CLI!)).digest('hex') }))
})
const capacity = () => Object.assign(new Error('Capacity machine fact'), { code: 'ENOSPC' })
const turn = async () => { for (let count = 0; count < 12; count++) await Promise.resolve() }

it('current wait wake cancels its timer and listeners without carrying any credit into the next wait', async () => {
  const controller = cancellation(); let wake: (() => boolean) | undefined, reads = 0
  const pending = retry({ operationId: 'original', signal: controller.signal, setWake: next => { wake = next }, waiting: () => {},
    attempt: async ({ preparation }) => await preparation(async () => { if (++reads < 3) throw capacity(); return 'original' }) })
  void pending.catch(() => {})
  await turn(); expect(sleeps).toHaveLength(1)
  const first = wake!
  expect(first()).toBe(true); expect(wake).toBeUndefined(); expect(first()).toBe(false)
  await turn(); expect(reads).toBe(2); expect(sleeps).toHaveLength(2)
  expect(sleeps[0]!.signal.aborted).toBe(true); expect(sleeps[1]!.ms).toBe(2000)
  await turn(); expect(reads).toBe(2) // The old wake never releases the subsequent installed wait.
  sleeps[1]!.finish(); expect(await pending).toBe('original')
  expect(wake).toBeUndefined(); expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
})

it('timer completion and cancellation remove the original wake without replaying a failed read', async () => {
  const controller = cancellation(), failure = capacity(); let wake: (() => boolean) | undefined, reads = 0
  const pending = retry({ operationId: 'original', signal: controller.signal, setWake: next => { wake = next }, waiting: () => {},
    attempt: async ({ preparation }) => await preparation(async () => { reads++; throw failure }) }).catch(error => error)
  await turn(); const originalWake = wake!
  controller.abort(); expect(await pending).toBe(failure)
  expect(wake).toBeUndefined(); expect(originalWake()).toBe(false); expect(reads).toBe(1)
  expect(sleeps[0]!.signal.aborted).toBe(true); expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
})

it('wake settles only original failed cleanup before an exact negative creation can retry', async () => {
  const controller = cancellation(); let wake: (() => boolean) | undefined, attempts = 0
  const failure = Object.assign(new Failure('original negative', 'STORE_FAILURE', undefined, undefined, undefined,
    { operationId: 'original', disposition: 'not_applied' }), { cause: capacity(), cleanup: [capacity()],
    retryCreationCleanup: vi.fn(async () => { failure.cleanup = [] }) })
  const pending = retry({ operationId: 'original', signal: controller.signal, setWake: next => { wake = next }, waiting: () => {},
    attempt: async () => { if (++attempts === 1) throw failure; return 'same-original' } })
  void pending.catch(() => {})
  await turn(); expect(attempts).toBe(1)
  expect(wake!()).toBe(true); expect(await pending).toBe('same-original')
  expect(failure.retryCreationCleanup).toHaveBeenCalledTimes(1); expect(attempts).toBe(2)
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
})
