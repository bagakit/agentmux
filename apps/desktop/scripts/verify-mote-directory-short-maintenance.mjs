import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'

const base = resolve(import.meta.dirname, '../../..'), output = join(base, '.tmp/mote-directory-short-maintenance')
await mkdir(output, { recursive: true })
const attempt = await mkdtemp(join(output, 'attempt-')), isolated = join(attempt, 'source')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const native = 'apps/desktop/native/workspace-move.c', owner = 'apps/desktop/src/main/scratch-directory-maintenance.mjs'
const metadata = 'apps/desktop/src/main/scratch-directory-identity.mjs', directories = 'apps/desktop/src/main/scratch-topic-directories.ts'
const scratch = 'apps/desktop/src/main/scratch-topics.ts', files = 'apps/desktop/src/main/workspace-files.ts', ipc = 'apps/desktop/src/main/ipc.ts'
const test = 'apps/desktop/test/mote-directory-short-maintenance.test.ts', oldTest = 'apps/desktop/test/mote-directory-identity.test.ts'
const config = 'apps/desktop/scripts/fixtures/mote-directory-short-name/vitest.maintenance.config.mts'
// The supported Tracker command consumes one exact reviewed qualification;
// it never silently reruns the native/process matrix or invents a passing receipt.
const locatorPath = process.env.AGENTMUX_SHORT_MAINTENANCE_QUALIFICATION ?? join(output, 'qualification.json')
if (!process.argv.includes('--reuse-progress') && !process.argv.includes('--runtime-receipt')) {
  let locator
  try { locator = JSON.parse(await readFile(locatorPath, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (locator) {
    const readBound = async reference => {
      const bytes = await readFile(resolve(base, reference.path)); assert.equal(hash(bytes), reference.sha256, 'Qualification artifact drift: ' + reference.path)
      return JSON.parse(bytes)
    }
    const raw = await readBound(locator.receipt), review = await readBound(locator.review), manifest = await readBound(locator.manifest)
    assert.equal(raw.passed, true); assert.equal(raw.task, 'T-002'); assert.deepEqual(raw.sourceChanges, [])
    assert.equal(review.approved, true); assert.ok(review.tasks.includes('T-002'))
    assert.equal(review.sourceGate.sha256, locator.receipt.sha256); assert.equal(review.candidateManifestSha256, locator.manifest.sha256)
    assert.equal(review.runtimeReceipt.sha256, raw.runtime.sha256)
    assert.ok(Object.keys(manifest.paths).length); assert.ok(Object.keys(raw.source).length); assert.ok(raw.loadedProduction.length)
    assert.ok(raw.callers.length); assert.equal(raw.mutations.length, 14); assert.ok(raw.mutations.every(row => row.redExit !== 0 && row.restoredExit === 0))
    assert.equal(raw.types.diagnosticCount, 0); assert.ok(Object.keys(raw.types.source).length)
    const adapter = 'apps/desktop/scripts/verify-mote-directory-short-maintenance.mjs'
    for (const [file, digest] of Object.entries({ ...raw.source, ...raw.types.source, ...manifest.paths }))
      assert.equal(hash(await readFile(join(base, file))), digest, 'Reviewed candidate changed: ' + file)
    assert.equal(raw.source[adapter], hash(await readFile(join(base, adapter))), 'The reviewed adapter must itself be exact')
    for (const row of raw.loadedProduction) assert.equal(hash(await readFile(join(base, row.file))), row.sha256, 'Loaded Source changed: ' + row.file)
    const runtimeBytes = await readFile(resolve(base, raw.runtime.path)); assert.equal(hash(runtimeBytes), raw.runtime.sha256)
    const joined = { schema: 'agentmux.mote-directory-short-maintenance.join.v1', task: 'T-002', passed: true,
      qualification: locator.receipt, review: locator.review, manifest: locator.manifest, runtime: { path: raw.runtime.path, sha256: raw.runtime.sha256 },
      featureHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: base, encoding: 'utf8' }).trim(),
      boundary: raw.boundary, userDataTouched: false }
    await writeFile(join(attempt, 'receipt.json'), JSON.stringify(joined, null, 2))
    console.log(JSON.stringify({ passed: true, receipt: relative(base, join(attempt, 'receipt.json')), exactQualificationReused: true }))
    process.exit(0)
  }
}
const receipt = { schema: 'agentmux.mote-directory-short-maintenance.t002.v1', task: 'T-002', passed: false,
  sourceQualified: false, source: {}, callers: [], runs: [], mutations: [], loadedProduction: [], userDataTouched: false,
  boundary: 'Original Main/CLI metadata maintenance, generic native helper and original FileReadOwner over private fixtures. Source-only compiler graph. Actual private Core/Runtime restart is separately exact-bound; no package, install, user App/Run, Renderer redesign or Browser Native claim.' }
const inputs = new Map()
async function bind(file) { const bytes = await readFile(join(base, file)); inputs.set(file, hash(bytes)); return bytes }
async function tree(path) { for (const entry of await readdir(join(base, path), { withFileTypes: true })) {
  const file = join(path, entry.name); if (entry.isDirectory()) await tree(file); else if (entry.isFile()) await bind(file)
} }
async function run(label, args, env = {}, cwd = isolated) {
  let text = ''
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', bytes => text += bytes); child.stderr.on('data', bytes => text += bytes)
  const timer = setTimeout(() => child.kill('SIGKILL'), 90_000)
  const result = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal })) })
  clearTimeout(timer); await writeFile(join(attempt, label + '.log'), text)
  const row = { label, command: args.map(value => value.startsWith(base) ? relative(base, value) : value), ...result,
    log: label + '.log', logSha256: hash(text) }
  receipt.runs.push(row); assert.equal(result.signal, null, 'Termination is not behavior qualification: ' + label)
  return { ...row, text }
}
function green(row, minimum) {
  assert.equal(row.code, 0, row.text.slice(-7000))
  const counts = [...row.text.matchAll(/Tests\s+(\d+) passed/g), ...row.text.matchAll(/pass (\d+)\b/g)]
  assert.ok(counts.some(match => Number(match[1]) >= minimum), 'Nonempty owning assertions: ' + row.label)
}
async function loaded(path) {
  const rows = (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.ok(rows.length, 'Actual imported Source proof cannot be empty'); return rows
}
const checks = [
  { symbol: 'startup advisory maintenance', definition: scratch, caller: ipc, anchor: 'normalizeDirectoryIdentities(scratchForIdentity, { shortenMotes: true })' },
  { symbol: 'same maintenance owner', definition: owner, caller: scratch, anchor: 'await migrateTopicDirectories(' },
  { symbol: 'explicit maintenance CLI', definition: owner, caller: 'apps/desktop/scripts/migrate-topic-directories.mjs', anchor: 'await migrateTopicDirectories(' },
  { symbol: 'native same-operation exchange', definition: native, caller: owner, anchor: "await runHelper(helperPath, ['--alias-swap'" },
  { symbol: 'strict original raw witness', definition: metadata, caller: owner, anchor: 'await inspectDirectoryIdentity(' },
  { symbol: 'primary confirmed alias protection', definition: directories, caller: files, anchor: 'await scratchConfirmedDirectoryPaths(primary.path' },
  { symbol: 'actual public File directory scope', definition: scratch, caller: ipc, anchor: 'topicForDirectory:' }
]
const mutations = [
  { id: 'same-object-double-swap', file: native, from: 'flock(object_fd, LOCK_EX) != 0', to: '0', pattern: 'two actual helpers serialize' },
  { id: 'foreign-equal-text-stage-adopted', file: native, from: 'if (expected) verify_entry(fd, name, expected, 0, operation);', to: '(void)expected; /* omit exact original stage inode */', pattern: 'same-text foreign stage arriving' },
  { id: 'source-parent-eio-ignored', file: native, from: 'sync_fault == 1 ? (errno = EIO, -1) : fsync(source_fd)', to: 'fsync(source_fd)', pattern: 'actual source parent fsync EIO' },
  { id: 'destination-parent-eio-ignored', file: native, from: 'sync_fault == 2 ? (errno = EIO, -1) : fsync(destination_fd)', to: 'fsync(destination_fd)', pattern: 'actual destination parent fsync EIO' },
  { id: 'after-fsync-parent-binding-lost', file: native,
    from: 'verify_entry(root_fd, to.parent, &destination_parent, 1, "after-sync-destination-parent");', to: '/* omit post-flush named parent */', pattern: 'post-fsync visible parent replacement' },
  { id: 'owned-stage-takes-away-files', file: directories, from: 'if (target === directory) { stages.push(', to: 'if (false && target === directory) { stages.push(', pattern: 'actual beforeSwap helper death' },
  { id: 'metadata-only-retires-move', file: metadata, from: 'if (before.aliasPending) throw new DirectoryAliasConfirmationRequiredError(before.identityDirectoryPath)',
    to: 'if (false && before.aliasPending) throw new DirectoryAliasConfirmationRequiredError(before.identityDirectoryPath)', pattern: 'actual beforeSwap helper death' },
  { id: 'intermediate-primary-alias-unprotected', file: files, from: 'if (physicalPrimary) for (const path of await scratchConfirmedDirectoryPaths(',
    to: 'if (false && physicalPrimary) for (const path of await scratchConfirmedDirectoryPaths(', pattern: 'real primary deletion protects' },
  { id: 'preview-writes-original-object', file: owner, from: "if (!execute) { row.state =", to: "if (!execute) { await ensureDirectory(join(physical, 'unrequested-preview-entry')); row.state =", pattern: 'actual discovery, File reads' },
  { id: 'startup-moves-ordinary-topic', file: scratch, from: 'execute: true, motesOnly: true,', to: 'execute: true, motesOnly: false,', pattern: 'original startup maintenance owner repairs' },
  { id: 'startup-service-fact-disappears', file: scratch, from: 'if (issues.length) result.issues = [...new Set(issues)]', to: 'if (topicIds.issues?.length) result.issues = topicIds.issues', pattern: 'startup failure before any alias witness' },
  { id: 'metadata-failure-replaces-shortening-fact', file: scratch,
    from: 'if (!(this.directoryMaintenanceIssue?.directory === workspace.path && this.directoryMaintenanceIssue.shortenMotes && !options.shortenMotes))',
    to: 'if (true)', pattern: 'startup failure before any alias witness' },
  { id: 'startup-waits-for-maintenance', file: ipc, from: 'if (scratchForIdentity) void Promise.resolve().then(', to: 'if (scratchForIdentity) await Promise.resolve().then(', pattern: 'executes the original IPC startup', test: oldTest },
  { id: 'new-physical-path-reissues-identity', file: directories, from: 'if (saved) return saved', to: 'if (saved) return physical', pattern: 'original topics Mote is shortened' }
]
try {
  for (const path of ['apps/desktop/src', 'packages/core/src']) await tree(path)
  const copyTrees = ['apps/desktop/src', 'apps/desktop/test/fixtures', 'packages/core/src', 'packages/core/test/helpers']
  const copyFiles = [test, oldTest, 'apps/desktop/test/mote-primary-directory.test.ts', 'apps/desktop/test/topic-directory-migration.native.test.mjs',
    'apps/desktop/native/workspace-move.c', 'apps/desktop/scripts/migrate-topic-directories.mjs', 'apps/desktop/scripts/migrate-topic-directories.d.mts',
    'apps/desktop/scripts/build-workspace-move-helper.mjs', 'apps/desktop/scripts/verify-mote-directory-short-maintenance.mjs',
    'apps/desktop/scripts/verify-mote-directory-short-name.mjs', 'apps/desktop/package.json', 'packages/core/package.json', 'tsconfig.base.json', 'vitest.setup.ts']
  await mkdir(isolated)
  for (const path of copyTrees) await cp(join(base, path), join(isolated, path), { recursive: true })
  for (const file of copyFiles) { await bind(file); await mkdir(dirname(join(isolated, file)), { recursive: true }); await cp(join(base, file), join(isolated, file)) }
  for (const name of ['mote-directory-short-name', 'mote-directory-identity', 'mote-navigation-footer']) {
    const path = 'apps/desktop/scripts/fixtures/' + name; await tree(path); await cp(join(base, path), join(isolated, path), { recursive: true })
  }
  for (const path of ['node_modules', 'apps/desktop/node_modules', 'packages/core/node_modules', 'packages/core/vendor', 'packages/demand', 'packages/layout', 'packages/client-ui']) {
    await mkdir(dirname(join(isolated, path)), { recursive: true }); await symlink(join(base, path), join(isolated, path))
  }
  await writeFile(join(isolated, 'package.json'), '{"type":"module"}')
  assert.equal((await run('compile-original-helper', ['apps/desktop/scripts/build-workspace-move-helper.mjs'])).code, 0)
  for (const check of checks) {
    assert.notEqual(check.definition, check.caller)
    const line = (await readFile(join(base, check.caller), 'utf8')).split('\n').findIndex(line => line.includes(check.anchor) && !line.trim().startsWith('import '))
    assert.ok(line >= 0, 'Actual external production caller: ' + check.symbol)
    receipt.callers.push({ ...check, line: line + 1, sha256: inputs.get(check.caller) })
  }
  const vitest = [join(base, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, '--reporter=verbose'], proof = join(attempt, 'loaded-production.ndjson')
  const reuseIndex = process.argv.indexOf('--reuse-progress')
  let prior, priorDirectory
  if (reuseIndex >= 0) {
    const priorPath = resolve(process.argv[reuseIndex + 1]), bytes = await readFile(priorPath)
    prior = JSON.parse(bytes); priorDirectory = dirname(priorPath)
    assert.equal(prior.schema, receipt.schema); assert.deepEqual(prior.sourceChanges, []); assert.ok(Object.keys(prior.source).length)
    for (const [file, digest] of Object.entries(prior.source)) if (file !== 'apps/desktop/scripts/verify-mote-directory-short-maintenance.mjs')
      assert.equal(hash(await readFile(join(base, file))), digest, 'Prior production/test Source changed: ' + file)
    assert.equal([...prior.runs, ...prior.priorRuns ?? []].find(row => row.label === 'owning-native-baseline')?.code, 0)
    assert.ok(prior.loadedProduction.length)
    for (const row of prior.loadedProduction) assert.equal(row.sha256, hash(await readFile(join(base, row.file))), 'Prior loaded Source changed: ' + row.file)
    receipt.loadedProduction = prior.loadedProduction
    receipt.reusedProgress = { path: relative(base, priorPath), sha256: hash(bytes), reason: 'Exact unchanged production, fixture and baseline Source. Verifier repairs do not invalidate completed unchanged behavior facts; each actual RED/restored log and loaded mutant is checked before reuse.' }
    receipt.priorRuns = [...prior.runs, ...prior.priorRuns ?? []]
  } else {
    green(await run('owning-native-baseline', vitest, { AGENTMUX_DIRECTORY_IDENTITY_PROOF: proof }), 56)
    receipt.loadedProduction = [...new Map((await loaded(proof)).map(row => [row.consumer + ':' + row.file, row])).values()]
  }
  for (const consumer of ['actual-vite-module', 'actual-source-cli-bundle']) assert.ok(receipt.loadedProduction.some(row => row.consumer === consumer && row.file.startsWith('packages/core/src/')), 'Nonempty actual Core imports: ' + consumer)
  assert.ok(receipt.loadedProduction.some(row => row.file === owner), 'Main maintenance implementation is actually imported')
  for (const variant of mutations) {
    const original = await readFile(join(base, variant.file), 'utf8')
    assert.equal(original.split(variant.from).length, 2, 'One exact mutation anchor: ' + variant.id)
    const changed = original.replace(variant.from, variant.to), redProof = join(attempt, variant.id + '.ndjson')
    const completed = prior?.mutations.find(row => row.id === variant.id)
    if (completed) {
      assert.equal(completed.file, variant.file); assert.equal(completed.mutatedSha256, hash(changed)); assert.notEqual(completed.redExit, 0); assert.equal(completed.restoredExit, 0)
      for (const key of ['redLog', 'restoredLog']) {
        const log = await readFile(join(priorDirectory, completed[key])), row = prior.runs.find(row => row.log === completed[key])
        assert.ok(row); assert.equal(row.logSha256, hash(log)); await writeFile(join(attempt, completed[key]), log); receipt.runs.push({ ...row, reusedExactSource: true })
      }
      const priorProof = await loaded(join(priorDirectory, variant.id + '.ndjson'))
      assert.ok(priorProof.some(row => row.file === variant.file && row.sha256 === hash(changed)))
      await cp(join(priorDirectory, variant.id + '.ndjson'), redProof)
      receipt.mutations.push({ ...completed, exactPriorSource: true }); continue
    }
    await writeFile(join(isolated, variant.file), changed)
    if (variant.file === native) assert.equal((await run(variant.id + '-compile', ['apps/desktop/scripts/build-workspace-move-helper.mjs'])).code, 0)
    const args = [...vitest, variant.test ?? test, '-t', variant.pattern]
    let red
    try {
      red = await run(variant.id + '-red', args, { AGENTMUX_DIRECTORY_IDENTITY_PROOF: redProof })
      assert.notEqual(red.code, 0, 'Actual mutant survived: ' + variant.id)
      assert.match(red.text, /AssertionError:/, 'Behavior assertion RED, not load/timeout: ' + variant.id)
      assert.doesNotMatch(red.text, /Cannot find module|Cannot find package|Failed to resolve import|SyntaxError:|No test files found/)
      const rows = await loaded(redProof)
      assert.ok(rows.some(row => row.file === variant.file && row.sha256 === hash(changed)), 'Changed production Source actually loaded: ' + variant.id)
    } finally {
      await writeFile(join(isolated, variant.file), original)
      if (variant.file === native) assert.equal((await run(variant.id + '-restore-compile', ['apps/desktop/scripts/build-workspace-move-helper.mjs'])).code, 0)
    }
    green(await run(variant.id + '-restored', args), 1)
    receipt.mutations.push({ id: variant.id, file: variant.file, mutatedSha256: hash(changed), redExit: red.code, redLog: red.log, restoredExit: 0, restoredLog: variant.id + '-restored.log' })
    console.log(variant.id + ': actual loaded AssertionRED / restored GREEN')
  }
  const priorNative = prior?.runs.find(row => row.label === 'original-native-baseline')
  if (priorNative?.code === 0) {
    const bytes = await readFile(join(priorDirectory, priorNative.log)); assert.equal(hash(bytes), priorNative.logSha256)
    await writeFile(join(attempt, priorNative.log), bytes); receipt.runs.push({ ...priorNative, reusedExactSource: true })
  } else green(await run('original-native-baseline', ['--test', '--test-reporter=spec', 'apps/desktop/test/topic-directory-migration.native.test.mjs']), 10)
  if (prior?.sourceQualified) {
    assert.equal(prior.types?.diagnosticCount, 0); assert.ok(Object.keys(prior.types.source).length)
    for (const [file, digest] of Object.entries(prior.types.source)) assert.equal(hash(await readFile(join(base, file))), digest, 'Actual type graph changed: ' + file)
    receipt.types = prior.types
  } else {
  const require = createRequire(join(base, 'package.json')), ts = require('typescript'), paths = {}
  for (const name of ['core', 'demand', 'layout', 'client-ui']) for (const [key, value] of Object.entries(JSON.parse(await readFile(join(base, 'packages', name, 'package.json'), 'utf8')).exports)) {
    let target = typeof value === 'string' ? value : name === 'client-ui' ? value.browser : value.import
    if (!target || target.endsWith('.json')) continue
    if (name === 'core') target = target.replace('./dist/', './src/').replace(/\.js$/, '.ts')
    else if (name !== 'client-ui') target = target.replace('./dist/', './').replace(/\.js$/, '.ts')
    paths['@agentmux/' + name + (key === '.' ? '' : key.slice(1))] = ['packages/' + name + '/' + target.replace(/^\.\//, '')]
  }
  const options = ts.convertCompilerOptionsFromJson({ target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', noEmit: true, strict: true,
    noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, skipLibCheck: true, esModuleInterop: true, allowImportingTsExtensions: true,
    resolveJsonModule: true, baseUrl: '.', paths, types: ['node'] }, base)
  const program = ts.createProgram([scratch, directories, files, ipc, 'apps/desktop/src/main/scratch-directory-maintenance.d.mts'].map(file => join(base, file)), options.options)
  const errors = [...options.errors, ...ts.getPreEmitDiagnostics(program)]
  receipt.types = { diagnosticCount: errors.length, errors: errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, ' ')), source: {} }
  for (const file of program.getSourceFiles()) if (file.fileName.startsWith(base + '/') && !file.fileName.includes('/node_modules/') && !file.fileName.includes('/vendor/'))
    receipt.types.source[relative(base, file.fileName)] = hash(await readFile(file.fileName))
  assert.ok(Object.keys(receipt.types.source).length); assert.equal(errors.length, 0, receipt.types.errors.join('\n'))
  }
  receipt.sourceQualified = true
  const index = process.argv.indexOf('--runtime-receipt')
  if (index < 0) throw new Error('Source qualified; exact real private Runtime restart receipt is still required for T-002 completion.')
  const runtimePath = resolve(process.argv[index + 1]), runtimeBytes = await readFile(runtimePath), runtime = JSON.parse(runtimeBytes)
  assert.equal(runtime.passed, true); assert.ok(Object.keys(runtime.source).length); assert.equal(runtime.phases.length, 2)
  for (const file of [native, metadata, owner, directories, scratch, 'apps/desktop/scripts/fixtures/mote-directory-short-runtime/owner.ts']) assert.equal(runtime.source[file], hash(await readFile(join(base, file))), 'Runtime consumed exact candidate: ' + file)
  assert.ok(runtime.harnessSource && Object.keys(runtime.harnessSource).length === 3, 'All three real Runtime harness files must be exact-bound')
  for (const [file, digest] of Object.entries(runtime.harnessSource)) assert.equal(digest, hash(await readFile(join(base, file))), 'Runtime driver changed: ' + file)
  assert.notEqual(runtime.seed.pid, runtime.restored.pid); assert.equal(runtime.seed.run.runId, runtime.restored.run.runId)
  assert.equal(runtime.cleanup.privateRootRemoved, true); assert.deepEqual(runtime.cleanup.errors, [])
  receipt.runtime = { path: relative(base, runtimePath), sha256: hash(runtimeBytes), ...runtime }
  receipt.passed = true
} catch (error) { receipt.error = error.stack; process.exitCode = 1 }
finally {
  receipt.source = Object.fromEntries(inputs); receipt.sourceChanges = []
  for (const [file, digest] of inputs) if (hash(await readFile(join(base, file))) !== digest) receipt.sourceChanges.push(file)
  if (receipt.sourceChanges.length) { receipt.passed = false; receipt.error = 'Candidate Source changed during qualification'; process.exitCode = 1 }
  await rm(isolated, { recursive: true, force: true }); receipt.privateSourceRemoved = true
  await writeFile(join(attempt, 'receipt.json'), JSON.stringify(receipt, null, 2))
  console.log(JSON.stringify({ passed: receipt.passed, sourceQualified: receipt.sourceQualified, receipt: relative(base, join(attempt, 'receipt.json')), error: receipt.error }))
}
