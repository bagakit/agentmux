import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// Explicit local maintenance only. Normal startup never imports the old decoder.
const root = resolve(import.meta.dirname, '../../..')
let request, temporary, database, child, closed, pending, readyResolve, readyReject, completed = 0
let stage = 'original-request', startReceiptStored = false
const events = []
const report = (name, facts = {}) => {
  const event = { operationId: request.operationId, stage: name, ...facts }
  events.push(event); process.stdout.write(JSON.stringify(event) + '\n')
}
const failed = () => new Error('Original native credential request is unconfirmed.')
try {
  if (!process.argv[2] || process.argv.length !== 3) throw failed()
  const requestBytes = await readFile(await realpath(process.argv[2]))
  request = JSON.parse(requestBytes.toString('utf8'))
  if (!request.operationId || !request.evidenceDirectory || request.applicationName !== 'AgentMux') throw failed()
  temporary = await mkdtemp(join(tmpdir(), 'amux-credential-transfer-'))
  const require = createRequire(resolve(root, 'apps/desktop/package.json'))
  const { build } = createRequire(require.resolve('electron-vite/package.json'))('esbuild')
  stage = 'maintenance-build'
  const converterFile = join(temporary, 'converter.cjs'), nativeFile = join(temporary, 'native.cjs'), inputs = {}
  for (const [entry, outfile] of [['connection-credential-conversion.ts', converterFile], ['migrate-connection-credentials-main.ts', nativeFile]]) {
    const compiled = await build({ absWorkingDir: root, entryPoints: [resolve(root, 'apps/desktop/scripts/lib', entry)], outfile,
      bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'], metafile: true, logLevel: 'silent',
      plugins: [{ name: 'original-maintenance-core-leaves', setup(builder) {
        builder.onResolve({ filter: /^@agentmux\/core$/ }, () => ({ path: 'original-core-leaves', namespace: 'maintenance-core' }))
        builder.onLoad({ filter: /.*/, namespace: 'maintenance-core' }, () => ({ resolveDir: root,
          contents: `export { AgentMuxError } from ${JSON.stringify(resolve(root, 'packages/core/src/errors.ts'))}; export { mintObjectId } from ${JSON.stringify(resolve(root, 'packages/core/src/object-id.ts'))};` }))
        builder.onResolve({ filter: /^@agentmux\/identity$/ }, () => ({ path: resolve(root, 'packages/identity/src/index.ts') }))
      } }] })
    for (const name of Object.keys(compiled.metafile.inputs)) if (!name.startsWith('maintenance-core:')) inputs[name] = createHash('sha256').update(await readFile(resolve(root, name))).digest('hex')
  }
  await writeFile(join(request.evidenceDirectory, 'execution.json'), JSON.stringify({ operationId: request.operationId,
    requestSha256: createHash('sha256').update(requestBytes).digest('hex'),
    compiledSha256: createHash('sha256').update(await readFile(nativeFile)).digest('hex'),
    converterSha256: createHash('sha256').update(await readFile(converterFile)).digest('hex'), inputs }, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  stage = 'original-database'
  const file = await lstat(request.databasePath), directory = await lstat(dirname(request.databasePath))
  if (!file.isFile() || file.isSymbolicLink() || !directory.isDirectory() || directory.isSymbolicLink() ||
      String(file.dev) !== request.expectedDatabase.device || String(file.ino) !== request.expectedDatabase.inode ||
      file.uid !== process.getuid() || directory.uid !== process.getuid() || (file.mode & 0o077) || (directory.mode & 0o077)) throw failed()
  database = new DatabaseSync(request.databasePath)
  const { convertConnectionCredentials } = createRequire(converterFile)(converterFile)
  const nativeReady = async () => {
    if (child) return
    stage = 'native-ready'
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
    void ready.catch(() => {}) // A child failure may precede the asynchronous start receipt write.
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    child = spawn(require('electron'), [nativeFile, join(temporary, 'isolated-user-data')], { cwd: root, env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    closed = new Promise(resolve => {
      child.once('error', () => { readyReject(failed()); pending?.reject(failed()); pending = undefined; resolve({ exitCode: null, started: false }) })
      child.once('close', exitCode => { readyReject(failed()); pending?.reject(failed()); pending = undefined; resolve({ exitCode, started: true }) })
    })
    child.on('message', message => {
      if (message?.kind === 'ready') { readyResolve(); return }
      if (message?.kind === 'stage' && ['opening-original-provider', 'reading-original-credentials'].includes(message.stage)) { report(message.stage); return }
      if (message?.kind === 'progress' && Number.isSafeInteger(message.completed) && message.completed === completed) { report('reading-original-credentials', { completed }); return }
      if (message?.kind === 'decrypted' && pending?.id === message.id && typeof message.plaintext === 'string') {
        const original = pending; pending = undefined; completed++; original.resolve(message.plaintext); return
      }
      readyReject(failed()); pending?.reject(failed()); pending = undefined
    })
    try {
      await writeFile(join(request.evidenceDirectory, 'execution-started.json'), JSON.stringify({ operationId: request.operationId, parentPid: process.pid, pid: child.pid }, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
      startReceiptStored = true
    } catch { /* This exact child must be closed; never replay native work after a lost start receipt. */ }
    await ready
  }
  stage = 'original-backup-and-conversion'
  const result = await convertConnectionCredentials({ database, backup: request.backup, decryptLegacy: async ciphertext => {
    await nativeReady()
    stage = 'native-decrypt'
    if (pending || !child.connected) throw failed()
    const id = completed + 1
    const value = await new Promise((resolve, reject) => {
      pending = { id, resolve, reject }
      // Default Node JSON IPC preserves the standard Buffer shape across Node/V8 versions.
      child.send({ kind: 'decrypt', id, ciphertext }, error => { if (error && pending?.id === id) { pending = undefined; reject(failed()) } })
    })
    stage = 'original-backup-and-conversion'
    return value
  } })
  stage = 'conversion-receipt'
  await writeFile(join(request.evidenceDirectory, 'conversion-receipt.json'), JSON.stringify({ operationId: request.operationId,
    databaseIdentity: request.expectedDatabase, backup: request.backup, result,
    boundary: 'Node owns original SQLite/backup/CAS. Original Electron provider exchanges values only through anonymous JSON IPC. No platform request, owner stop, key export or keychain deletion.' }, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  report('conversion-confirmed', result)
  process.exitCode = 0
} catch {
  if (request?.operationId) report('conversion-unconfirmed', { failedStage: stage, originalRequestKept: true, keychainDeleted: false })
  else process.stdout.write(JSON.stringify({ stage: 'conversion-unconfirmed', failedStage: stage }) + '\n')
  process.exitCode = 1
} finally {
  try { database?.close() } catch { process.exitCode = 1 }
  if (child?.connected) child.send({ kind: 'close' }, () => {})
  const result = closed ? await closed : { exitCode: null, started: false }
  if (result.started && result.exitCode !== 0) process.exitCode = 1
  if (request?.evidenceDirectory) try {
    await writeFile(join(request.evidenceDirectory, 'execution-result.json'), JSON.stringify({ operationId: request.operationId, ...result, parentExitCode: process.exitCode, startReceiptStored, events }, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  } catch { process.exitCode = 1 }
  if (temporary) await rm(temporary, { recursive: true, force: true })
}
