import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

// Explicit local maintenance only. Normal startup never imports the old decoder.
const root = resolve(import.meta.dirname, '../../..')
const requestPath = process.argv[2]
if (!requestPath || process.argv.length !== 3) throw new Error('Usage: node apps/desktop/scripts/migrate-connection-credentials.mjs ORIGINAL_REQUEST.json')
const originalRequest = await realpath(requestPath)
const requestBytes = await readFile(originalRequest)
const request = JSON.parse(requestBytes.toString('utf8'))
if (!request.operationId || !request.evidenceDirectory) throw new Error('The original conversion request is incomplete.')
const temporary = await mkdtemp(join(tmpdir(), 'amux-credential-transfer-'))
const require = createRequire(resolve(root, 'apps/desktop/package.json'))
const events = []
try {
  const { build } = require('esbuild')
  const outfile = join(temporary, 'main.cjs')
  const compiled = await build({ entryPoints: [resolve(root, 'apps/desktop/scripts/lib/migrate-connection-credentials-main.ts')], outfile,
    bundle: true, platform: 'node', format: 'cjs', target: 'node24', packages: 'external', metafile: true,
    plugins: [{ name: 'original-maintenance-core-leaves', setup(builder) {
      builder.onResolve({ filter: /^@agentmux\/core$/u }, () => ({ path: 'original-core-leaves', namespace: 'maintenance-core' }))
      builder.onLoad({ filter: /.*/u, namespace: 'maintenance-core' }, () => ({ resolveDir: root,
        contents: `export { AgentMuxError } from ${JSON.stringify(resolve(root, 'packages/core/src/errors.ts'))}; export { mintObjectId } from ${JSON.stringify(resolve(root, 'packages/core/src/object-id.ts'))};` }))
      builder.onResolve({ filter: /^@agentmux\/identity$/u }, () => ({ path: resolve(root, 'packages/identity/src/index.ts') }))
    } }] })
  const inputs = {}
  for (const name of Object.keys(compiled.metafile.inputs)) {
    if (name.startsWith('maintenance-core:')) continue
    inputs[name] = createHash('sha256').update(await readFile(resolve(root, name))).digest('hex')
  }
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const frozenRequest = join(temporary, 'original-request.json')
  await writeFile(frozenRequest, requestBytes, { mode: 0o600, flag: 'wx' })
  await writeFile(join(request.evidenceDirectory, 'execution.json'), JSON.stringify({ operationId: request.operationId,
    requestSha256: createHash('sha256').update(requestBytes).digest('hex'),
    compiledSha256: createHash('sha256').update(await readFile(outfile)).digest('hex'), inputs }, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  const child = spawn(require('electron'), [outfile, frozenRequest], { cwd: root, env, stdio: ['ignore', 'pipe', 'ignore'] })
  const closed = new Promise(resolve => { child.once('error', () => resolve({ exitCode: null, started: false })); child.once('close', exitCode => resolve({ exitCode, started: true })) })
  let pending = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    pending += chunk
    const lines = pending.split('\n'); pending = lines.pop()
    for (const line of lines) {
      if (!line.startsWith('AMUX_CREDENTIAL_TRANSFER ')) continue
      try {
        const event = JSON.parse(line.slice('AMUX_CREDENTIAL_TRANSFER '.length))
        events.push(event); process.stdout.write(JSON.stringify(event) + '\n')
      } catch { /* Native diagnostic output is never forwarded as credential evidence. */ }
    }
  })
  let startReceiptStored = false
  try {
    await writeFile(join(request.evidenceDirectory, 'execution-started.json'), JSON.stringify({ operationId: request.operationId, pid: child.pid }, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    startReceiptStored = true
  } catch { /* Await this exact process even when recording its start fails. Never replay it. */ }
  const result = await closed
  await writeFile(join(request.evidenceDirectory, 'execution-result.json'), JSON.stringify({ operationId: request.operationId, ...result, startReceiptStored, events }, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  process.exitCode = result.exitCode ?? 1
} finally {
  await rm(temporary, { recursive: true, force: true })
}
