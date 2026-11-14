import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { createRequire, registerHooks, stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const script = fileURLToPath(import.meta.url), core = resolve(dirname(script), '..')
const variant = process.env.AGENTMUX_NAMESPACE_MUTATION ?? 'candidate'
const check = (value, message) => assert.ok(value, `T006: ${message}`)
const digest = value => createHash('sha256').update(value).digest('hex')
process.umask(0o077)

function sourceLoader() {
  const ts = createRequire(join(core, 'package.json'))('typescript')
  registerHooks({
    resolve(specifier, context, next) {
      if ((specifier.startsWith('.') || specifier.startsWith('/')) && specifier.endsWith('.js') && context.parentURL?.startsWith('file:')) {
        const target = fileURLToPath(new URL(specifier, context.parentURL)), source = target.slice(0, -3) + '.ts'
        if (!existsSync(target) && existsSync(source)) return { url: pathToFileURL(source).href, shortCircuit: true }
      }
      return next(specifier, context)
    },
    load(url, context, next) {
      if (!url.startsWith('file:') || !url.endsWith('.ts')) return next(url, context)
      const path = fileURLToPath(url)
      let source = readFileSync(path, 'utf8')
      const replace = (from, to) => { check(source.includes(from), `mutation anchor ${variant}`); source = source.replace(from, to) }
      if (path === join(core, 'src/immutable-identity-file.ts')) {
        if (variant === 'ignore-original') replace('let original = await optional(custody)\n  if (original === null)', 'let original = null\n  if (original === null)')
        if (variant === 'ignore-prior') replace('if (!recovered && await options.priorIdentity?.())', 'if (false)')
        if (variant === 'overwrite-conflict') replace("if (original === null || !isDeepStrictEqual(options.parse(original), value)) throw", "if (false) throw")
      }
      if (path === join(core, 'src/agent-session-database.ts') && variant === 'empty-reinitialize')
        replace('if (header === null) await assertNewDatabaseNamespace(path)', 'if (false) await assertNewDatabaseNamespace(path)')
      return { format: 'module', shortCircuit: true, source: ts.transpileModule(source, { fileName: path,
        compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true, esModuleInterop: true } }).outputText }
    }
  })
}

if (process.argv.includes('--child')) {
  sourceLoader()
  const root = process.env.AGENTMUX_NAMESPACE_ROOT
  check(root, 'private root required')
  process.env.AGENTMUX_STATE_DIRECTORY = join(root, 'state')
  process.env.AGENTMUX_RUNTIME_DIRECTORY = join(root, 'native-unavailable')
  process.env.AGENTMUX_MESSAGE_QUEUE_PATH = join(root, 'messages.ndjson')
  const { startHeadlessAgentMux } = await import('../src/headless-runtime.ts')
  const { AgentMuxFileAgentSessionStore } = await import('../src/agent-session-store.ts')
  const { immutableIdentityFile } = await import('../src/immutable-identity-file.ts')
  const { readCurrentSessionDatabase } = await import('../src/agent-session-database.ts')
  const { connectAgentMuxRpc } = await import('../src/public-rpc-client.ts')
  const { CtxmuxRunAdapter } = await import('../src/ctxmux-run-adapter.ts')
  const { AgentMuxError } = await import('../src/errors.ts')
  // Identity persistence needs the actual semantic Host, not a native daemon.
  // Control only this external connection leaf; all identity/Store/RPC owners run.
  CtxmuxRunAdapter.prototype.connect = async () => { throw new AgentMuxError('Private test Native leaf is unavailable.', 'CTXMUX_DISCONNECTED') }
  const phase = process.argv.at(-1), stateDirectory = join(root, 'state'), path = join(root, 'sessions.sqlite')
  if (phase === 'first' || phase === 'second') {
    const runtime = await startHeadlessAgentMux({ store: new AgentMuxFileAgentSessionStore(path), stateDirectory, socketPath: join(root, 'control.sock') })
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: runtime.socketPath } })
    try {
      const owner = await rpc.call('runtime.owner.identity', {})
      const identity = await runtime.client.agentCreationAuthority()
      check(owner.owner.runtimeId === identity.runtimeId, 'actual Unix RPC and original signer share the semantic owner')
      console.log(JSON.stringify({ runtimeId: identity.runtimeId, fingerprint: identity.fingerprint, ownerInstanceId: owner.owner.ownerInstanceId }))
    } finally { await rpc.dispose(); await runtime.stop() }
  } else if (phase === 'guards') {
    const options = { parse: bytes => JSON.parse(bytes), create: () => ({ id: 'new' }), encode: value => JSON.stringify(value) }
    const identityPath = join(root, 'guard.json')
    await writeFile(identityPath, JSON.stringify({ id: 'current' }), { mode: 0o600 })
    await writeFile(identityPath + '.original', JSON.stringify({ id: 'other' }), { mode: 0o600 })
    let conflict = false
    try { await immutableIdentityFile(identityPath, options) } catch (error) { conflict = error.code === 'IDENTITY_SOURCE_CONFLICT' }
    check(conflict, 'conflicting complete identity must retain both and refuse adoption')
    const missingPath = join(root, 'known-used.json')
    let missing = false
    try { await immutableIdentityFile(missingPath, { ...options, priorIdentity: async () => true }) } catch (error) { missing = error.code === 'IDENTITY_SOURCE_MISSING' }
    check(missing && !existsSync(missingPath), 'known used namespace cannot create a replacement identity')
    const archivePath = join(root, 'lost.sqlite')
    await writeFile(archivePath + '.original-' + 'a'.repeat(64), '{}')
    let blocked = false
    try { await readCurrentSessionDatabase(archivePath, { readOnly: true }) } catch { blocked = true }
    check(blocked && !existsSync(archivePath), 'original archive prevents treating a lost catalog as first launch')
    console.log(JSON.stringify({ guards: true }))
  }
} else {
  const root = await mkdtemp(join(tmpdir(), 'amx-ns-proof-')), results = []
  const worker = join(core, 'dist/control-endpoint-listener-worker.js')
  let previousWorker
  try { previousWorker = await readFile(worker) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const workerBytes = stripTypeScriptTypes(await readFile(join(core, 'src/control-endpoint-listener-worker.ts'), 'utf8'), { mode: 'transform' })
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_')))
  const child = (variant, phase) => spawnSync(process.execPath, [script, '--child', phase], { env: { ...env,
    AGENTMUX_NAMESPACE_MUTATION: variant, AGENTMUX_NAMESPACE_ROOT: root }, encoding: 'utf8', timeout: 45_000, maxBuffer: 1024 * 1024 })
  try {
    await mkdir(dirname(worker), { recursive: true }); await writeFile(worker, workerBytes, { mode: 0o600 })
    for (const variant of ['candidate', 'ignore-prior', 'overwrite-conflict', 'empty-reinitialize']) {
      const result = child(variant, 'guards')
      if (variant === 'candidate') assert.equal(result.status, 0, result.stderr)
      else check(result.status !== 0 && result.stderr.includes('T006:') && result.stderr.includes('AssertionError'), `causal ${variant}: ${result.stderr}`)
      results.push({ variant, passed: variant === 'candidate', rejected: variant !== 'candidate' })
      for (const name of ['guard.json', 'guard.json.original', 'known-used.json', 'known-used.json.original']) await rm(join(root, name), { force: true })
    }
    const first = child('candidate', 'first'); assert.equal(first.status, 0, first.stderr)
    const original = JSON.parse(first.stdout.trim())
    const identityPaths = ['semantic-runtime.json', 'agent-creation-identity.json'].map(name => join(root, 'state', name))
    const originalBytes = await Promise.all(identityPaths.map(path => readFile(path)))
    for (const path of identityPaths) await unlink(path)
    const second = child('candidate', 'second'); assert.equal(second.status, 0, second.stderr)
    const recovered = JSON.parse(second.stdout.trim())
    assert.equal(recovered.runtimeId, original.runtimeId); assert.equal(recovered.fingerprint, original.fingerprint)
    check(recovered.ownerInstanceId !== original.ownerInstanceId, 'a new real process retains the original semantic identity')
    for (let index = 0; index < identityPaths.length; index++) assert.deepEqual(await readFile(identityPaths[index]), originalBytes[index])
    for (const path of identityPaths) await unlink(path)
    const mutation = child('ignore-original', 'second')
    check(mutation.status !== 0 ? /IDENTITY_SOURCE_MISSING|AGENT_CREATION_AUTHORITY_INVALID|IDENTITY_SOURCE_CONFLICT/u.test(mutation.stderr) :
      JSON.parse(mutation.stdout.trim()).runtimeId !== original.runtimeId, 'ignoring the original source fails by an identity guard or actually changes identity')
    results.push({ variant: 'ignore-original', rejected: true }, { separateProcesses: true, publicUnixRpc: true, exactRuntimeAndSigningIdentity: true, originalBytes: true })
    const unit = spawnSync(process.execPath, ['../../node_modules/vitest/vitest.mjs', 'run', '--config', 'test/durable-namespace.config.mts'], { cwd: core, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 })
    assert.equal(unit.status, 0, unit.stdout + unit.stderr)
    const sources = ['src/immutable-identity-file.ts', 'src/headless-runtime.ts', 'src/agent-creation-authority.ts', 'src/agent-session-database.ts', 'test/durable-namespace.test.ts', 'scripts/verify-durable-namespace.mjs']
    const receipt = { verdict: 'pass', sourceHashes: Object.fromEntries(await Promise.all(sources.map(async path => [path, digest(await readFile(join(core, path)))]))), results,
      scope: 'Actual Headless owner, Unix RPC and signing owner in two separate processes; controlled directory EIO in owner tests; no real Native Runtime or Agent starts.', cleanup: 'private synthetic roots removed' }
    if (process.env.AGENTMUX_RELIABILITY_EVIDENCE_DIRECTORY) { await mkdir(process.env.AGENTMUX_RELIABILITY_EVIDENCE_DIRECTORY, { recursive: true, mode: 0o700 }); await writeFile(join(process.env.AGENTMUX_RELIABILITY_EVIDENCE_DIRECTORY, 'durable-namespace.private.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 }) }
    console.log(JSON.stringify(receipt, null, 2))
  } finally {
    if ((await readFile(worker, 'utf8')) === workerBytes) { if (previousWorker) await writeFile(worker, previousWorker); else await rm(worker, { force: true }) }
    await rm(root, { recursive: true, force: true })
  }
}
