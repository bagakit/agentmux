declare module '@ctxmux/sdk' {
  export const PROTOCOL_VERSION: 13
  export const RUNTIME_CAPABILITY_NATIVE_START: 'native.start'
  export const RUNTIME_CAPABILITY_NATIVE_RECOVERABLE_INPUT: 'native.recoverable_input'
  export const RUNTIME_CAPABILITY_NATIVE_RECOVERABLE_STOP: 'native.recoverable_stop'
  export const RUNTIME_CAPABILITY_PERSISTENT_STATE: 'services.persistent_state'
  export const RUNTIME_CAPABILITY_PLANNED_EXEC_UPGRADE_CONTINUITY: 'services.planned_exec_upgrade_continuity'

  export type RunId = string

  export type RunState =
    | { type: 'running' }
    | { type: 'exited'; code: number; signal: string | null }
    | { type: 'interrupted'; reason: string }

  export type RunInfo = {
    id: RunId
    spec: {
      program: string
      args: string[]
      cwd: string | null
      env: Record<string, string>
      size: { cols: number; rows: number }
      declared_inputs: unknown[]
    } | null
    pid: number | null
    state: RunState
    latest_output_bytes: number
    durable_output_bytes: number | null
    first_available_byte: number
    attachments: number
    applied_input_bytes: number | null
  }

  export type OutputChunk = {
    start_byte: number
    end_byte: number
    data: number[]
  }

  export type RecoverableInputOperation = {
    daemonInstance: string
    operationKey: string
    runId: RunId
    expectedByte: number
    data: string | Uint8Array
  }

  export type RecoverableStopOperation = {
    daemonInstance: string
    operationKey: string
    runId: RunId
  }

  export type RuntimeIdentity = {
    daemonInstanceId: string
    runtimeId: string
    runtimeIdPersistence: 'daemon' | 'state_dir'
    buildId: string
    protocolGeneration: number
    platform: string
    arch: string
    capabilities: Record<string, number>
  }

  export type RunEvent =
    | { type: 'output'; chunk: OutputChunk }
    | { type: 'exited'; state: RunState }
    | { type: 'interrupted'; reason: string }
    | { type: 'gap'; latest_output_bytes: number }
    | { type: 'tmux'; event: unknown }

  export type Attachment = {
    readonly snapshot: {
      run: RunInfo
      replay: {
        chunks: OutputChunk[]
        first_available_byte: number
        latest_output_bytes: number
        truncated: boolean
      }
    }
    detach(): Promise<void>
    close(): void
    events(): AsyncGenerator<RunEvent, void, void>
  }

  export class CtxmuxProtocolError extends Error {
    readonly code: string
  }

  export class CtxmuxCommandError extends CtxmuxProtocolError {
    readonly disposition: 'not_applied' | 'unknown'
  }

  export class CtxmuxRuntimeIdentityMismatchError extends Error {
    readonly expected: RuntimeIdentity
    readonly actual: RuntimeIdentity
  }

  export class CtxmuxClient {
    constructor(options: {
      socketPath: string
      expectedRuntimeIdentity?: RuntimeIdentity
      requiredCapabilities?: Readonly<Record<string, number>>
    })
    ping(): Promise<void>
    daemonInstance(): Promise<string>
    runtimeInfo(): Promise<RuntimeIdentity>
    start(spec: ReturnType<typeof defineRun>, operationKey?: string): Promise<RunInfo>
    list(): Promise<readonly RunInfo[]>
    status(id: RunId): Promise<RunInfo>
    recoverableInput(operation: RecoverableInputOperation): Promise<{
      run: RunInfo
      receipt: { start_byte: number; end_byte: number }
    }>
    resize(id: RunId, size: { cols: number; rows: number }): Promise<{
      run: RunInfo
      receipt: { type: 'resize'; applied_size: { cols: number; rows: number } }
    }>
    interrupt(id: RunId): Promise<unknown>
    prepareStop(id: RunId, operationKey?: string): Promise<RecoverableStopOperation>
    stop(operation: RecoverableStopOperation): Promise<unknown>
    attachRecoverableStop(operation: RecoverableStopOperation, afterByte?: number): Promise<{
      attachment: Attachment
      stop: { run: RunInfo; receipt: { type: 'stop'; disposition: string } }
    }>
    attach(id: RunId, afterByte?: number): Promise<Attachment>
  }

  export function createOperationKey(value?: string): string
  export function defineRun(program: string, options?: {
    args?: readonly string[]
    cwd?: string | null
    env?: Readonly<Record<string, string>>
    size?: { cols: number; rows: number }
  }): {
    program: string
    args: string[]
    cwd: string | null
    env: Record<string, string>
    size: { cols: number; rows: number }
    declared_inputs: unknown[]
  }
}
