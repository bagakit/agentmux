import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import type { NoteFileWitness } from '@agentmux/core/note-history'
import type { FilePathScopeWitness, FileEntryWitness, FileMoveEntry } from '@agentmux/core/files'
import type { WorkspaceFileByteRead } from './workspace-file-bytes.js'
const LOCAL_WORKER_READY = 'AGENTMUX_WORKSPACE_READY'
const LOCAL_WORKER_ERROR = 'AGENTMUX_WORKSPACE_ERROR:'

export type WorkspaceFileWorkerRequest =
  | { action: 'path-stat'; path: string }
  | { action: 'path-related'; path: string; entry: FileEntryWitness }
  | { action: 'path-move' | 'path-move-inspect'; path: string; destination: { root: string; path: string }; stage: string;
      expected: FilePathScopeWitness & { entry: FileMoveEntry }; destinationExpected: FilePathScopeWitness; claimed?: boolean; fault?: string }
  | { action: 'path-mkdir'; path: string; stage: string; digest: string; expected: FilePathScopeWitness; fault?: string }
  | { action: 'path-inspect'; path: string; stage: string; digest: string; expected: FilePathScopeWitness; createdWitness: FileEntryWitness }
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
      createMode?: number
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
  options: { helperPath: string; workerSource: string; spawnFiniteFileProducer?: (spawn: (fd: number) => ChildProcess) => ChildProcess },
  input?: string | Uint8Array,
  signal?: AbortSignal,
  barriers?: { before?: () => Promise<void>; after?: () => Promise<void>; stage?: (value: unknown) => Promise<void> }
): Promise<Buffer> {
  signal?.throwIfAborted()
  const environment: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  delete environment.NODE_OPTIONS
  const native = request.action !== 'observe' && request.action !== 'list-files'
  const pathWitness = (w: FilePathScopeWitness['root']) => [w.device, w.inode, w.size, w.ctimeNs, w.mtimeNs, w.birthtimeNs ?? 'unavailable'].join(':')
  const args = request.action === 'path-related' ? ['--workspace-path', 'related', pathWitness(request.entry), request.path]
    : request.action === 'path-move' || request.action === 'path-move-inspect' ? [
      '--workspace-path', request.action === 'path-move' ? 'move' : 'move-inspect', root, request.path, request.destination.root, request.destination.path,
      request.stage, pathWitness(request.expected.root), pathWitness(request.expected.parent), pathWitness(request.expected.entry.witness), request.expected.entry.kind,
      pathWitness(request.destinationExpected.root), pathWitness(request.destinationExpected.parent), request.claimed ? 'claimed' : 'staged', request.fault ?? ''
    ]
    : request.action === 'path-stat' ? ['--workspace-path', 'stat', root, request.path]
    : request.action === 'path-mkdir' || request.action === 'path-inspect' ? [
      '--workspace-path', request.action === 'path-mkdir' ? 'mkdir' : 'inspect', root, request.path,
      request.stage, request.digest, pathWitness(request.expected.root), pathWitness(request.expected.parent), request.action === 'path-mkdir' ? request.fault ?? '' : pathWitness(request.createdWitness)
    ] : request.action === 'delete-exact' ? [
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
    request.action === 'read-bytes' ? request.expectedRevision ?? 'null' : 'null',
    ...(request.action === 'write' && request.createMode !== undefined ? [String(request.createMode)] : [])
  ] : [
    '--input-type=module',
    '--eval',
    options.workerSource,
    JSON.stringify(request),
    root
  ]
  const stdio: StdioOptions = barriers ? ['pipe', 'pipe', 'pipe', barriers.before || barriers.stage ? 'pipe' : 'ignore',
    barriers.before || barriers.stage ? 'pipe' : 'ignore', barriers.after ? 'pipe' : 'ignore', barriers.after ? 'pipe' : 'ignore'] : ['pipe', 'pipe', 'pipe']
  const start = (ownerLeaseFd?: number) => spawn(native ? options.helperPath : process.execPath, args, {
    cwd, env: environment,
    stdio: ownerLeaseFd === undefined ? stdio : [...stdio, ...Array(Math.max(0, 7 - stdio.length)).fill('ignore'), ownerLeaseFd] as StdioOptions,
    ...(signal ? { signal } : {})
  })
  // Scope -> original owner borrow -> spawn is one synchronous turn. FD7 is
  // never passed to a read helper or an Agent/Terminal/Capsule Runtime Run.
  const child = request.action === 'path-move' && options.spawnFiniteFileProducer
    ? options.spawnFiniteFileProducer(fd => start(fd)) : start()

  const stdout: Buffer[] = []
  let stderr = ''
  let inputSent = false
  let inputError: Error | undefined
  let barrierError: Error | undefined, claimed = false
  for (const [index, hook] of [[3, barriers?.stage ?? barriers?.before], [5, barriers?.after]] as const) {
    if (!hook) continue
    const ready = child.stdio.at(index) as Readable, release = child.stdio.at(index + 1) as Writable
    const failed = (error: unknown) => { barrierError ??= error instanceof Error ? error : new Error(String(error)); child.kill('SIGTERM') }
    release.on('error', failed)
    if (index === 3 && barriers?.stage) {
      let body = '', running = false, offers = 0
      ready.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8')
        if (Buffer.byteLength(body) > 4096) { failed(new Error('The original native phase witness exceeded its protocol budget.')); return }
        for (let end = body.indexOf('\n'); end >= 0; end = body.indexOf('\n')) {
          const line = body.slice(0, end); body = body.slice(end + 1)
          if (running || ++offers > 2) { failed(new Error('The original native producer offered an unexpected phase.')); return }
          running = true
          try { void barriers.stage!(JSON.parse(line)).then(() => { running = false; release.write('G') }, failed) }
          catch (error) { failed(error) }
        }
      })
    } else ready.once('data', () => {
      if (index === 5) claimed = true
      void (hook as () => Promise<void>)().then(() => release.end('G'), failed)
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

  let childError: Error | undefined
  // A reader/error result is not producer quiescence. Mutation scopes may be
  // released only after this original child has closed all its process IO.
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('error', error => { childError = error })
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  if (result.code === 0 && !inputError && !barrierError && !childError) return Buffer.concat(stdout)
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
  throw Object.assign(barrierError ?? inputError ?? childError ?? new Error(
    `Local Workspace operation failed${result.signal ? ` with ${result.signal}` : ` with exit ${result.code}`}`
  ), (request.action === 'write' || request.action === 'delete-exact' || request.action === 'path-mkdir' || request.action === 'path-move') && inputSent ? {
    code: 'WORKSPACE_FILE_RESULT_UNKNOWN', writeOutcomeUnknown: true,
    ...(request.action === 'delete-exact' && claimed ? { retainedPath: request.claim } : {})
  } : {})
}
