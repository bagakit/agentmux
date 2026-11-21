import { fork } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { AgentConfigurationInspection } from '@agentmux/core'
import type { AgentSessionControl, RuntimeEvent } from '../../src/shared/contracts'

type Ready = { type: 'ready'; control: AgentSessionControl; inspection: Extract<AgentConfigurationInspection, { kind: 'configuration' }>; endpoint: string }
type Reply = { type: 'reply'; id: number; result?: unknown; error?: { code?: string; message: string; controlFailure?: unknown; detail?: string } }

/** Actual Main/Core stay in Node; Browser consumers receive only their original IPC data. */
export async function modelStateMainClient(onEvent: (event: RuntimeEvent) => void, native = false) {
  const directory = await mkdtemp(resolve(tmpdir(), 'amx-model-ui-'))
  const owner = resolve(import.meta.dirname, '../../../../packages/core/test/fixtures/model-state-main-owner.mjs')
  const child = fork(owner, [directory, ...(native ? ['native'] : [])], { execArgv: ['--experimental-transform-types'], env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
  let stderr = '', counter = 0
  child.stderr?.on('data', bytes => { stderr += String(bytes) })
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  let readyResolve!: (value: Ready) => void, readyReject!: (error: Error) => void
  const ready = new Promise<Ready>((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  const deadline = setTimeout(() => readyReject(new Error(`The private Main owner did not become ready. ${stderr}`)), native ? 120000 : 10000)
  child.on('message', value => {
    const message = value as Ready | Reply | { type: 'runtime-event'; event: RuntimeEvent }
    if (message.type === 'ready') { clearTimeout(deadline); readyResolve(message) }
    else if (message.type === 'runtime-event') onEvent(message.event)
    else if (message.type === 'reply') {
      const request = pending.get(message.id)
      if (!request) return
      pending.delete(message.id)
      if (message.error) request.reject(Object.assign(new Error(message.error.message), message.error))
      else request.resolve(message.result)
    }
  })
  child.once('error', error => readyReject(error))
  child.once('exit', code => {
    clearTimeout(deadline)
    const error = new Error(`The private Main owner exited (${code}). ${stderr}`)
    readyReject(error)
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  })
  const call = <T>(method: string, args: unknown[] = []): Promise<T> => new Promise((resolve, reject) => {
    const id = ++counter
    pending.set(id, { resolve: value => resolve(value as T), reject })
    child.send({ type: 'call', id, method, args }, error => { if (error) { pending.delete(id); reject(error) } })
  })
  async function close() {
    clearTimeout(deadline)
    if (child.exitCode === null && child.signalCode === null && child.connected) await call('close').catch(() => {})
    if (child.exitCode === null && child.signalCode === null) await exited
    await rm(directory, { recursive: true, force: true })
    return { exitCode: child.exitCode, directoryRemoved: true }
  }
  try { return { ready: await ready, call, close } }
  catch (error) { if (child.exitCode === null) child.kill('SIGTERM'); await close(); throw error }
}
