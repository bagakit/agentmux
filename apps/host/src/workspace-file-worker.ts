import { spawn } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import type { NoteFileWitness } from '@agentmux/core/note-history'
import type { WorkspaceFileByteRead } from './workspace-file-bytes.js'
const LOCAL_WORKER_READY = 'AGENTMUX_WORKSPACE_READY'
const LOCAL_WORKER_ERROR = 'AGENTMUX_WORKSPACE_ERROR:'

export type WorkspaceFileWorkerRequest =
  | { action: 'read'; name: string }
  | { action: 'read-bytes'; name: string; offset: number; maxBytes: number; maxFileBytes: number; expectedRevision?: string }
  | { action: 'list' }
  | { action: 'list-files'; limit: number }
  | { action: 'reveal'; name: string | null }
  | { action: 'observe'; name: string }
  | {
      action: 'write'
      name: string
      expectedRevision: string | null
      exclusive?: true
      textOnly?: true
      fault?: 'temporary-write' | 'replace' | 'receipt' | 'occupy'
    }
  | { action: 'create'; name: string; kind: 'file' | 'directory' }
  | { action: 'delete'; name: string }
  | { action: 'delete-exact'; name: string; expectedRevision: string; witness: NoteFileWitness; claim: string; fault: string }

export async function runWorkspaceFileWorker(
  cwd: string,
  root: string,
  request: WorkspaceFileWorkerRequest,
  options: { helperPath: string; workerSource: string },
  input?: string | Uint8Array,
  signal?: AbortSignal,
  deleteBarriers?: { before?: () => Promise<void>; after?: () => Promise<void> }
): Promise<Buffer> {
  signal?.throwIfAborted()
  const environment: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  delete environment.NODE_OPTIONS
  const native = request.action !== 'observe' && request.action !== 'list-files'
  const args = request.action === 'delete-exact' ? [
    '--workspace-file', request.action, root, request.name, request.expectedRevision,
    request.witness.device, request.witness.inode, request.witness.size, request.witness.ctimeNs,
    request.witness.mtimeNs, request.claim, request.fault
  ] : native ? [
    '--workspace-file', request.action, root, 'name' in request ? request.name ?? '' : '',
    request.action === 'write' ? request.expectedRevision ?? 'null' : request.action === 'create' ? request.kind : 'null',
    request.action === 'write' && request.exclusive ? '1' : '0',
    request.action === 'write' && request.textOnly ? '1' : '0',
    request.action === 'write' ? request.fault ?? '' : '',
    request.action === 'read-bytes' ? String(request.offset) : '0',
    request.action === 'read-bytes' ? String(request.maxBytes) : '0',
    request.action === 'read-bytes' ? String(request.maxFileBytes) : '0',
    request.action === 'read-bytes' ? request.expectedRevision ?? 'null' : 'null'
  ] : [
    '--input-type=module',
    '--eval',
    options.workerSource,
    JSON.stringify(request),
    root
  ]
  const child = spawn(native ? options.helperPath : process.execPath, args, {
    cwd,
    env: environment,
    stdio: deleteBarriers ? ['pipe', 'pipe', 'pipe', deleteBarriers.before ? 'pipe' : 'ignore',
      deleteBarriers.before ? 'pipe' : 'ignore', deleteBarriers.after ? 'pipe' : 'ignore', deleteBarriers.after ? 'pipe' : 'ignore'] : ['pipe', 'pipe', 'pipe'],
    ...(signal ? { signal } : {})
  })
  const stdout: Buffer[] = []
  let stderr = ''
  let inputSent = false
  let inputError: Error | undefined
  let barrierError: Error | undefined, claimed = false
  for (const [index, hook] of [[3, deleteBarriers?.before], [5, deleteBarriers?.after]] as const) {
    if (!hook) continue
    const ready = child.stdio.at(index) as Readable, release = child.stdio.at(index + 1) as Writable
    release.on('error', error => { barrierError ??= error })
    ready.once('data', () => {
      if (index === 5) claimed = true
      void hook().then(() => release.end('G'), error => {
        barrierError = error instanceof Error ? error : new Error(String(error)); child.kill('SIGTERM')
      })
    })
  }
  // Cancellation or an early worker exit can close this pipe before READY is consumed.
  // Keep its failure on this original request, including after the child emits AbortError.
  child.stdin!.on('error', error => { inputError = error })
  child.stdout!.on('data', (chunk: Buffer) => stdout.push(Buffer.from(chunk)))
  child.stderr!.setEncoding('utf8')
  child.stderr!.on('data', (chunk: string) => {
    stderr += chunk
    if (!inputSent && stderr.split('\n').includes(LOCAL_WORKER_READY)) {
      inputSent = true
      child.stdin!.end(input ?? '')
    }
  })

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  if (result.code === 0 && !inputError && !barrierError) return Buffer.concat(stdout)
  const record = stderr.split('\n').find((line) => line.startsWith(LOCAL_WORKER_ERROR))
  if (record) {
    const detail = JSON.parse(record.slice(LOCAL_WORKER_ERROR.length)) as {
      message: string
      code: string | null
      writeOutcomeUnknown?: boolean
      retainedPath?: string
      readCost?: WorkspaceFileByteRead['readCost']
    }
    throw Object.assign(new Error(detail.message), detail.code ? { code: detail.code } : {},
      detail.writeOutcomeUnknown ? { writeOutcomeUnknown: true } : {}, detail.readCost ? { readCost: detail.readCost } : {},
      detail.retainedPath ? { retainedPath: detail.retainedPath } : {})
  }
  throw Object.assign(barrierError ?? inputError ?? new Error(
    `Local Workspace operation failed${result.signal ? ` with ${result.signal}` : ` with exit ${result.code}`}`
  ), (request.action === 'write' || request.action === 'delete-exact') && inputSent ? {
    code: 'WORKSPACE_FILE_RESULT_UNKNOWN', writeOutcomeUnknown: true,
    ...(request.action === 'delete-exact' && claimed ? { retainedPath: request.claim } : {})
  } : {})
}
