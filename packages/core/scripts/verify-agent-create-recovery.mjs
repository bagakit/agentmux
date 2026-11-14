import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

process.umask(0o077)
const core = resolve(dirname(fileURLToPath(import.meta.url)), '..'), repo = resolve(core, '../..')
const common = resolve(repo, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: repo, encoding: 'utf8' }).trim())
const main = dirname(common), vendor = join(core, 'vendor'), platform = `${process.platform}-${process.arch}`
const evidence = process.env.AGENTMUX_RELIABILITY_EVIDENCE_DIRECTORY ?? join(repo, '.local/reliability-fixes/runtime')
const loader = join(core, 'scripts/helpers/core-source-loader.mjs'), fixture = join(core, 'test/fixtures/agent-create-recovery-proof.mjs')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const change = (path, from, to) => ({ path, from, to })
const baseVariants = [
  { name: 'prepare-process-death', stage: 'prepare' },
  { name: 'dispatch-process-death', stage: 'dispatch' },
  { name: 'argv-carried-original', stage: 'dispatch', delivery: 'positional-argv' },
  { name: 'commit-process-death', stage: 'commit' },
  { name: 'full-request-mismatch', stage: 'mismatch' },
  { name: 'different-real-runtime', stage: 'runtime' },
  { name: 'different-launch-subject', stage: 'subject' },
  { name: 'schema-namespace', stage: 'namespace' },
  { name: 'cross-sid-cid-admission', stage: 'concurrency' },
  { name: 'legacy-positive-retained', stage: 'legacy' },
  { name: 'legacy-no-retained', stage: 'legacy-missing' },
  { name: 'deny-legacy-positive', stage: 'legacy', mutations: [change('/src/client.ts',
    'if (!original.preparedDispatch && !observedRetained) {',
    "if (!original.preparedDispatch && !observedRetained) throw new AgentMuxError('Mutation: refuse positive legacy witness', 'AGENT_CREATION_RESOLUTION_UNAVAILABLE')\n    if (!original.preparedDispatch && !observedRetained) {")], assertion: 'legacy retained observation admission survives owner-process interruption' },
  { name: 'legacy-observation-fences', stage: 'legacy', mutations: [change('/src/client.ts',
    'if (pending.creationResolution?.observedRetained) return this.projectPreparedCreation(pending)', '')], assertion: 'a retained observation read gap cannot authorize retirement' },
  { name: 'missing-durable-dispatch', stage: 'prepare', mutations: [change('/src/client.ts',
    'this.registry.prepareCreate(reservation, preparedCreation!, preparedDispatch)', 'this.registry.prepareCreate(reservation, preparedCreation!)')], assertion: 'new writer freezes its full request' },
  { name: 'inspect-commits-session', stage: 'dispatch', mutations: [change('/src/client.ts',
    'return this.projectPreparedCreation(correlation, false, run ?? undefined)', 'return run ? this.projectSession(await this.completePreparedCreate(correlation, run)) : this.projectPreparedCreation(correlation)')],
    assertion: 'exact positive inspect is pure read and cannot commit or publish a Session' },
  { name: 'accept-key-only-witness', stage: 'mismatch', mutations: [change('/src/ctxmux-run-adapter.ts',
    'if (!isDeepStrictEqual(observed.spec, request)) throw new AgentMuxError(', 'if (false) throw new AgentMuxError(')], assertion: 'cold reconcile cannot commit a same-key mismatching full request' },
  { name: 'accept-other-runtime', stage: 'runtime', mutations: [change('/src/ctxmux-run-adapter.ts',
    'if (expected && parseCreationRuntime(expected).runtimeId !== this.creationRuntimeIdentity().runtimeId) throw new AgentMuxError(', 'if (false) throw new AgentMuxError('),
    change('/src/ctxmux-run-adapter.ts', 'if (expected && runtime.runtimeId !== expected.runtimeId) throw new AgentMuxError(', 'if (false) throw new AgentMuxError(')], assertion: 'another real Runtime cannot confirm the original prepared creation' },
  { name: 'accept-other-subject', stage: 'subject', mutations: [change('/src/agent-prepared-resume.ts',
    'env.AGENTMUX_AGENT_SESSION_ID !== session.agentSessionId || env.AGENTMUX_PROVIDER_ID', 'false || env.AGENTMUX_PROVIDER_ID')], assertion: 'the actual launch subject must equal the prepared SID before admission' },
  { name: 'lose-original-correlation', stage: 'prepare', mutations: [change('/src/agent-session-store.ts',
    ')), ...closed],', ')), ...[]],')], assertion: 'closed no-Run original creation remains correlated' },
  { name: 'accept-foreign-caller-cid', stage: 'subject', mutations: [change('/src/agent-session-store.ts',
    "if (seed && (!seed.creation || operationId !== agentLifecycleOperationIdentity('create', seed.agentSessionId, seed.creation.createOperationId)))",
    'if (false)')], assertion: 'the original caller CID and SID must derive the actual lifecycle key' },
  { name: 'reconcile-key-only', stage: 'mismatch', mutations: [change('/src/client.ts',
    'this.completePreparedCreate(reservation, await this.inspectPreparedCreation(reservation))',
    'this.completePreparedCreate(reservation, await this.kernel.inspectCreation(reservation.operationId))')], assertion: 'cold reconcile cannot commit a same-key mismatching full request' },
  { name: 'memory-duplicate-cid', stage: 'concurrency', mutations: [change('/src/agent-session-store.ts',
    "const owner = creationSessionId([...this.sessions.values()], [...this.reservations.values(), ...this.closedCreations.values()], this.retiredAgentSessions, next.preparedCreation!.creation!.createOperationId)",
    'const owner = null')], assertion: 'memory original CID preparation rejects a concurrent distinct SID atomically' },
  { name: 'file-duplicate-cid', stage: 'concurrency', mutations: [change('/src/agent-session-store.ts',
    "const owner = this.creationOwner(this.db, next.preparedCreation!.creation!.createOperationId)", 'const owner = null')], assertion: 'file original CID preparation rejects a concurrent distinct SID atomically' },
  { name: 'missing-namespace-is-empty', stage: 'namespace', mutations: [change('/src/agent-session-store.ts',
    "throw new AgentMuxError('The acknowledged original creation history is unavailable. Restore its original table; existing active Sessions and inputs remain available.', 'AGENT_CREATION_HISTORY_UNAVAILABLE')",
    'return false')], assertion: 'v2 missing creation history stays unknown while active identity remains available' },
  { name: 'recreate-acknowledged-namespace', stage: 'namespace', mutations: [change('/src/agent-session-database.ts',
    "if (Number(db.prepare('PRAGMA user_version').get()?.user_version) !== 1) return false",
    'if (false) return false')], assertion: 'ordinary active input must not reconstruct an empty acknowledged creation history' },
  { name: 'never-upgrade-v1', stage: 'namespace', mutations: [change('/src/agent-session-database.ts',
    "if (Number(db.prepare('PRAGMA user_version').get()?.user_version) !== 1) return false", 'return false')], assertion: 'legitimate v1 upgrades once under the original namespace identity' },
  { name: 'closed-sid-reactivation', stage: 'prepare', mutations: [change('/src/agent-session-store.ts',
    "if (!current && next && closed) throw new AgentMuxError(", 'if (false) throw new AgentMuxError(')], assertion: 'file closed SID cannot be reactivated through compareAndSwap' },
  { name: 'unrelated-history-blocks-control', stage: 'namespace', mutations: [change('/src/agent-session-store.ts',
    "if (reservation.kind === 'create' && closedCreationNamespace(this.db) && this.db.prepare('SELECT 1 FROM closed_creations WHERE id=?').get(reservation.agentSessionId))",
    "if (closedCreationNamespace(this.db) && this.db.prepare('SELECT 1 FROM closed_creations WHERE id=?').get(reservation.agentSessionId))")], assertion: 'missing creation history cannot block formal control admission on an existing Run' },
  { name: 'never-redrive-original-control', stage: 'prepare', mutations: [change('/src/client.ts',
    '// The durable same-control admission authorizes redriving only this idempotent, monotone original key fence.',
    "if (original.creationResolution) return this.projectPreparedCreation(pending)\n        // Mutation: lose the admitted control's formal continuation.")], assertion: 'same explicit control redrives the exact monotone fence' },
  { name: 'drop-old-input-hold', stage: 'dispatch', mutations: [
    change('/src/agent-session-recovery/reconciliation.ts', "session.creation?.resolution?.initialInputContinuation !== 'held' && (controlled", '(controlled'),
    change('/src/client.ts', "current.creation?.resolution?.initialInputContinuation === 'held' || !input?.key", '!input?.key'),
    change('/src/client.ts', "current.creation?.resolution?.initialInputContinuation === 'held' || !input?.key", '!input?.key'),
    change('/src/client.ts', "if ((await this.store.readMetadata(original.agentSessionId))?.creation?.resolution?.initialInputContinuation === 'held') throw refused()", '')
  ], assertion: 'resolution does not rewrite old input or ACK' }
]
const variants = baseVariants.flatMap(value => value.mutations ? [value, { name: 'restore-' + value.name, stage: value.stage, restorationOf: value.name }] : [value])
const verifyOnly = process.argv.length === 3 && process.argv[2] === '--verify-existing-proof'
assert.ok(verifyOnly || process.argv.length === 2, 'Only the full real proof or --verify-existing-proof is accepted')
const daemonPath = join(main, 'packages/core/vendor/ctxmux', platform, 'bin/ctxmuxd')
const manifestPath = join(main, 'packages/core/vendor/ctxmux', platform, 'manifest.json')
const workerSource = join(core, 'src/control-endpoint-listener-worker.ts')
const workerAsset = join(evidence, 'agent-create-listener-worker.mjs')
const ts = createRequire(join(core, 'package.json'))('typescript')
const compileWorker = source => ts.transpileModule(source, { fileName: workerSource,
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true } }).outputText
const nodeIdentity = async () => ({ executable: process.execPath, sha256: hash(await readFile(process.execPath)), versions: process.versions,
  optionsDigest: hash(JSON.stringify([process.execArgv, process.env.NODE_OPTIONS ?? null, process.env.ELECTRON_RUN_AS_NODE ?? null])) })
const inputPath = source => source.checkoutRelative ? resolve(repo, source.checkoutRelative) : source.path
async function verifyExisting() {
  const receipt = JSON.parse(await readFile(join(evidence, 'agent-create-recovery.private.json'), 'utf8'))
  assert.equal(receipt.schema, 'agentmux.agent-create-recovery-proof.v1')
  assert.equal(receipt.verdict, 'pass'); assert.deepEqual(receipt.results.map(row => row.variant), variants.map(row => row.name))
  for (const [path, digest] of [[fileURLToPath(import.meta.url), receipt.runnerSHA256], [fixture, receipt.fixtureSHA256], [loader, receipt.loaderSHA256],
    [manifestPath, receipt.native.manifestSHA256], [daemonPath, receipt.native.binarySHA256], [workerSource, receipt.listenerAsset.sourceSHA256],
    [workerAsset, receipt.listenerAsset.transpiledSHA256]]) assert.equal(hash(await readFile(path)), digest, 'stale proof input: ' + path)
  assert.deepEqual(await nodeIdentity(), receipt.node, 'stale Node build/flags')
  assert.equal(hash(compileWorker(await readFile(workerSource, 'utf8'))), receipt.listenerAsset.transpiledSHA256, 'stale worker compiler or body')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  assert.equal(hash(await readFile(join(dirname(manifestPath), manifest.sdk.archive.path))), receipt.native.sdkArchiveSHA256, 'stale Native SDK archive')
  const checked = new Map()
  let nativeConsumers = 0, restored = 0, mutations = 0, sdkLoaded = false
  for (let index = 0; index < variants.length; index++) {
    const variant = variants[index], entry = receipt.results[index], bytes = await readFile(entry.evidence)
    assert.equal(hash(bytes), entry.sha256, 'changed real execution evidence')
    const record = JSON.parse(bytes)
    assert.equal(record.variant, variant.name); assert.deepEqual(record.cleanup.cleanupErrors, [])
    assert.ok(!existsSync(record.privateRoot), 'private resources have not been cleaned')
    assert.ok(Number.isInteger(record.cleanup.daemonPid) && record.cleanup.daemonPid > 1, 'actual private Native was used')
    assert.ok(record.sources.length > 0)
    for (const source of record.sources) {
      const path = inputPath(source)
      if (!checked.has(path)) checked.set(path, hash(await readFile(path)))
      assert.equal(checked.get(path), source.sourceSHA256, 'stale loaded source/dependency: ' + path)
      if (/@ctxmux[\/+]+sdk/u.test(path)) sdkLoaded = true
    }
    assert.ok(record.sources.some(row => row.checkoutRelative === 'packages/core/src/client.ts'), 'actual current SDK Client required')
    if (variant.mutations) {
      mutations++; assert.equal(record.outcome, 'mutation-rejected'); assert.equal(record.proof.assertion, variant.assertion)
      assert.ok(record.semanticAssertionObserved && record.failureStatus !== 0, 'actual business failure required')
      for (const change of variant.mutations) assert.ok(record.sources.some(row => row.path.endsWith(change.path) && row.sourceSHA256 !== row.loadedSHA256), 'actual loaded mutation required')
    } else {
      nativeConsumers++; if (variant.restorationOf) restored++
      assert.equal(record.outcome, 'pass'); assert.equal(record.proof.pass, true); assert.equal(record.proof.realPrivateNative, true)
      assert.ok(record.proof.rows.length > 0, 'nonempty consumer assertions required')
    }
  }
  assert.ok(nativeConsumers > 0 && restored > 0 && mutations > 0 && sdkLoaded, 'nonempty complete causal proof and actual SDK required')
  assert.equal(receipt.cleanup.privateRootsRemoved, true)
  console.log(JSON.stringify({ verdict: 'pass', mode: 'verified-existing-complete-proof', loadedInputs: checked.size, nativeConsumers, restored, mutations, nativeExecuted: false }))
}
if (verifyOnly) {
  try { await verifyExisting() }
  catch (cause) { throw new Error('STALE_OR_MISSING_REAL_PROOF: run the full actual Native/consumer/mutation proof before this verification.', { cause }) }
} else {
await mkdir(evidence, { recursive: true, mode: 0o700 })
const temporary = await mkdtemp(join(tmpdir(), 'amux-cr-')), results = []
let ownedVendorLink = false, cleanupUnknown = false, temporaryRemoved = false, vendorLinkRemoved = false
try {
  if (!existsSync(vendor)) { await symlink(join(main, 'packages/core/vendor'), vendor, 'dir'); ownedVendorLink = true }
  const daemon = join(vendor, 'ctxmux', platform, 'bin/ctxmuxd'), manifest = join(vendor, 'ctxmux', platform, 'manifest.json')
  assert.ok(existsSync(daemon), 'Exact vendored Native must be available; no external/user Runtime is substituted')
  await writeFile(workerAsset, compileWorker(await readFile(workerSource, 'utf8')), { mode: 0o600 })
  for (const variant of variants) {
    const root = join(temporary, variant.name.slice(0, 16)); await mkdir(root)
    const loaded = join(root, 'loaded.ndjson')
    const result = spawnSync(process.execPath, ['--import', loader, fixture, variant.stage], { cwd: repo, encoding: 'utf8', timeout: 100_000,
      maxBuffer: 1024 * 1024 * 3, env: { ...process.env, AGENTMUX_CREATE_PROOF_ROOT: root, AGENTMUX_CREATE_PROOF_DAEMON: daemon,
        AGENTMUX_SOURCE_LISTENER_ASSET: workerAsset,
        AGENTMUX_CREATE_PROOF_DELIVERY: variant.delivery ?? 'post-launch-only',
        AGENTMUX_SOURCE_LOAD_LOG: loaded, AGENTMUX_SOURCE_MUTATION_JSON: JSON.stringify(variant.mutations ?? []) } })
    if (!existsSync(join(root, 'cleanup.json'))) {
      cleanupUnknown = true
      const failure = { variant: variant.name, root, status: result.status, signal: result.signal, error: String(result.error ?? ''), stdout: result.stdout, stderr: result.stderr,
        ownedResources: existsSync(join(root, 'resource-journal.json')) ? JSON.parse(await readFile(join(root, 'resource-journal.json'), 'utf8')) : null }
      await writeFile(join(evidence, 'agent-create-harness-failure.private.json'), JSON.stringify(failure, null, 2) + '\n', { mode: 0o600 })
      assert.fail('Private fixture cleanup is unconfirmed; retained exact root for inspection: ' + JSON.stringify(failure))
    }
    const cleanup = JSON.parse(await readFile(join(root, 'cleanup.json'), 'utf8'))
    assert.deepEqual(cleanup.cleanupErrors, [], 'Private cleanup must finish even after a mutation')
    const modules = (await readFile(loaded, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.ok(modules.some(row => row.path === join(core, 'src/client.ts')), 'Actual current source Client was consumed')
    if (variant.mutations) {
      assert.notEqual(result.status, 0, 'Mutation must fail: ' + variant.name)
      assert.ok(result.stderr.includes('AssertionError') && result.stderr.includes('T005: ' + variant.assertion), `Causal assertion ${variant.name}: ${result.stderr}`)
      for (const mutation of variant.mutations) assert.ok(modules.some(row => row.path.endsWith(mutation.path) && row.sourceSHA256 !== row.loadedSHA256), 'Mutated source was loaded: ' + mutation.path)
    } else {
      assert.equal(result.status, 0, result.stderr)
      assert.ok(result.stdout.includes('AMUX_PROOF_JSON:'), 'Nonempty real consumer proof')
    }
    const record = { variant: variant.name, stage: variant.stage, privateRoot: root, outcome: variant.mutations ? 'mutation-rejected' : 'pass',
      ...(variant.mutations ? { semanticAssertionObserved: true, failureStatus: result.status } : {}),
      proof: variant.mutations ? { assertion: variant.assertion } : JSON.parse(result.stdout.split('AMUX_PROOF_JSON:').at(-1).trim()),
      cleanup, sources: [...new Map(modules.map(row => {
        const fromCheckout = relative(repo, row.path)
        return [row.path + ':' + row.loadedSHA256, { ...row, ...(!fromCheckout.startsWith('../') && !isAbsolute(fromCheckout) ? { checkoutRelative: fromCheckout } : {}) }]
      })).values()] }
    const output = join(evidence, `agent-create-${variant.name}.private.json`)
    await writeFile(output, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 })
    results.push({ variant: variant.name, outcome: record.outcome, evidence: output, sha256: hash(await readFile(output)) })
    console.log(`${variant.name}: ${record.outcome}`)
    await rm(root, { recursive: true, force: true })
  }
  await rm(temporary, { recursive: true, force: true }); temporaryRemoved = true
  if (ownedVendorLink) { await unlink(vendor); vendorLinkRemoved = true }
  const currentManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const receipt = { schema: 'agentmux.agent-create-recovery-proof.v1', verdict: 'pass', executedAt: new Date().toISOString(), head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    node: await nodeIdentity(),
    runnerSHA256: hash(await readFile(fileURLToPath(import.meta.url))), fixtureSHA256: hash(await readFile(fixture)), loaderSHA256: hash(await readFile(loader)),
    native: { manifestSHA256: hash(await readFile(manifestPath)), binarySHA256: hash(await readFile(daemonPath)), source: currentManifest.source,
      sdkArchiveSHA256: hash(await readFile(join(dirname(manifestPath), currentManifest.sdk.archive.path))) },
    listenerAsset: { sourceSHA256: hash(await readFile(workerSource)), transpiledSHA256: hash(await readFile(workerAsset)), boundary: 'only fork asset address redirected; exact current worker body and actual Node child used' },
    results, scope: 'Current source SDK/Store/adapter and exact vendored Native in private roots; real creator/resolver process death. Controlled interruption/ACK windows only. No user Runtime or production data; generated fixture credentials remain private and are removed with their root.',
    cleanup: { privateRootsRemoved: temporaryRemoved, temporaryVendorLinkRemoved: !ownedVendorLink || vendorLinkRemoved } }
  await writeFile(join(evidence, 'agent-create-recovery.private.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify({ verdict: 'pass', variants: results.length, evidence }))
} finally {
  if (!temporaryRemoved && !cleanupUnknown) await rm(temporary, { recursive: true, force: true })
  if (ownedVendorLink && !vendorLinkRemoved) await unlink(vendor)
}
}
