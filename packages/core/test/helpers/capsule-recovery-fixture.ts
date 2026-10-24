import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { vi } from 'vitest'
import { startCapsuleRuntime } from '@agentmux/capsule/runtime'
import type { AgentMuxClient } from '../../src/client.js'
import { CapsuleRunManager } from '../../src/capsule-run-manager.js'
import { AgentMuxError } from '../../src/errors.js'
import type { AgentMuxPreparedTerminal, AgentMuxPreparedTerminalStop } from '../../src/terminal-preparation.js'

/** Controlled Native results; real manager, Unix Capsule owner and HTTP. No user Runtime is contacted. */
export async function capsuleRecoveryFixture() {
  const directory = await mkdtemp('/tmp/amxrec-'), state = join(directory, 's')
  await mkdir(state)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', directory)
  const calls: { creates: AgentMuxPreparedTerminal[]; stops: AgentMuxPreparedTerminalStop[] } = { creates: [], stops: [] }
  let next = 0, current: { runId: string; kind: 'terminal'; state: 'running' | 'exited'; pid: number } | null = null
  let runtime: Awaited<ReturnType<typeof startCapsuleRuntime>> | undefined
  let startError: ((prepared: AgentMuxPreparedTerminal) => unknown) | undefined
  let stopError: unknown, gate: Promise<void> | undefined, release: (() => void) | undefined
  let serving = true, nextAck: Promise<void> | undefined, releaseAck: (() => void) | undefined
  const client = {
    connectRuntime: async () => {},
    prepareTerminal: () => {
      const createOperationId = 'native-create-' + ++next
      return { createOperationId, workspacePath: join(state, 'capsules'), launch: JSON.stringify({ createOperationId,
        request: { program: process.execPath, args: [], cwd: join(state, 'capsules'), env: { AGENTMUX_LIFECYCLE_OPERATION_ID: createOperationId },
          initial_size: { cols: 80, rows: 24 }, declared_inputs: [] } }) }
    },
    createPreparedTerminal: async (prepared: AgentMuxPreparedTerminal) => {
      calls.creates.push(structuredClone(prepared))
      await gate
      if (startError) throw startError(prepared)
      const created = { runId: 'run-' + next, kind: 'terminal' as const, state: 'running' as const, pid: process.pid }
      current = created
      const acknowledgment = nextAck; nextAck = undefined
      if (serving) runtime = await startCapsuleRuntime({ stateDirectory: manager.stateDirectory, socketPath: manager.socketPath })
      await acknowledgment
      return { ...created }
    },
    inspectPreparedTerminal: async (prepared: AgentMuxPreparedTerminal, ref?: { runId: string }) => {
      if (!current) return null
      if (ref && ref.runId !== current.runId) throw new Error('Wrong original Run')
      if (prepared.createOperationId !== calls.creates.at(-1)?.createOperationId) throw new Error('Wrong original creation')
      return { ...current }
    },
    prepareTerminalStop: async (run: { runId: string }) => ({ run, operationId: 'native-stop-' + calls.stops.length, ownerInstanceId: 'native-owner' }),
    stopPreparedTerminal: async (prepared: AgentMuxPreparedTerminalStop) => {
      calls.stops.push(structuredClone(prepared)); await gate
      if (stopError) throw stopError
      await runtime?.close(); runtime = undefined
      if (current) current.state = 'exited'
    }
  } as unknown as AgentMuxClient
  const manager = new CapsuleRunManager(client, state)
  const notApplied = (prepared: AgentMuxPreparedTerminal) => new AgentMuxError('Exact Native storage refusal', 'CTXMUX_storage_error', undefined, undefined, undefined,
    { operationId: prepared.createOperationId, disposition: 'not_applied' },
    { stage: 'start', sqlitePrimaryCode: 13, sqliteExtendedCode: 13, systemErrno: 28, transactionOutcome: 'not_started' })
  return { directory, state, manager, client, calls, notApplied,
    failStart: (error: typeof startError) => { startError = error }, failStop: (error: unknown) => { stopError = error },
    holdNextAck: () => { nextAck = new Promise<void>(yes => { releaseAck = yes }) }, releaseAck: () => releaseAck?.(),
    pause: () => { gate = new Promise<void>(yes => { release = yes }) }, release: () => { release?.(); gate = undefined },
    noEndpoint: () => { serving = false },
    openEndpoint: async () => { if (!runtime) runtime = await startCapsuleRuntime({ stateDirectory: manager.stateDirectory, socketPath: manager.socketPath }) },
    terminal: async () => { await runtime?.close(); runtime = undefined; if (current) current.state = 'exited' },
    close: async () => { release?.(); releaseAck?.(); await manager.dispose(); await runtime?.close(); await rm(directory, { recursive: true, force: true }) }
  }
}
