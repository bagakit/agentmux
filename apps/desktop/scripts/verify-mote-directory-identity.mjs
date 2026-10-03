import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { runTopicDirectoryMigrationMutations } from './verify-topic-directory-migration-mutations.mjs'

const base = resolve(import.meta.dirname, '../../..'), output = join(base, '.tmp/mote-directory-identity')
await mkdir(output, { recursive: true })
const attempt = await mkdtemp(join(output, 'attempt-')), isolated = join(attempt, 'source')
const schema = 'apps/desktop/src/main/scratch-directory-identity.mjs'
const scratch = 'apps/desktop/src/main/scratch-topics.ts'
const addresses = 'apps/desktop/src/shared/space-addresses.ts'
const observer = 'apps/desktop/src/main/rpc-client-observations.ts'
const ipc = 'apps/desktop/src/main/ipc.ts'
const directories = 'apps/desktop/src/main/scratch-topic-directories.ts'
const config = 'apps/desktop/scripts/fixtures/mote-directory-identity/vitest.config.mts'
const test = 'apps/desktop/test/mote-directory-identity.test.ts'
const nativeSource = 'apps/desktop/native/workspace-move.c'
const variants = [
  { id: 'absolute-record-returned', file: schema, from: 'return { version: 2, identityDirectoryName: name, identityPathHash: hash(original) }',
    to: 'return { version: 1, identityDirectoryPath: original }', pattern: 'new actual migrations' },
  { id: 'foreign-root-witness-accepted', file: schema, from: 'value.identityDirectoryName === expected.identityDirectoryName && value.identityPathHash === expected.identityPathHash',
    to: 'value.identityDirectoryName === expected.identityDirectoryName', pattern: 'invalid wrong-root' },
  { id: 'foreign-name-accepted', file: schema, from: 'value.identityDirectoryName === expected.identityDirectoryName && value.identityPathHash === expected.identityPathHash',
    to: 'value.identityPathHash === expected.identityPathHash', pattern: 'invalid wrong-name' },
  { id: 'original-identity-reissued', file: directories, from: 'if (identity) return identity', to: 'if (identity) return physical', pattern: 'new actual migrations' },
  { id: 'claimed-record-not-bound', file: nativeSource,
    from: 'if (!file_matches(fd, pending, old_dev, old_ino, old_hash, 0))\n        restore_claim(fd, pending, current, "file-publish-claimed-conflict");',
    to: '/* omit claimed original binding */', pattern: 'real native last-check window' },
  { id: 'publish-overwrites-new-fact', file: nativeSource,
    from: 'if (atomic_move_no_replace(fd, temporary, current) != 0)',
    to: 'if (renameatx_np(fd, temporary, fd, current, RENAME_NOFOLLOW_ANY | RENAME_RESOLVE_BENEATH) != 0)', pattern: 'no-replace publication keeps both' },
  { id: 'healthy-parent-refused', file: nativeSource,
    from: '(unsigned long long)meta.st_ino != parse_identity(argv[8], "parent inode")',
    to: '(unsigned long long)meta.st_ino == parse_identity(argv[8], "parent inode")', pattern: 'new actual migrations' },
  { id: 'confirmation-clears-later-witness', file: nativeSource,
    from: 'if (!file_matches(fd, temporary, old_dev, old_ino, old_hash, 0) || !file_matches(fd, current, 0, 0, new_hash, 0))',
    to: 'if (0)', pattern: 'last-check confirmation preserves later' },
  { id: 'publish-fault-drops-original-pending', file: nativeSource,
    from: 'if (sync_fault) { errno = EIO; fail_with_errno("file-publish-sync"); }',
    to: 'if (sync_fault) { unlinkat(fd, pending, 0); errno = EIO; fail_with_errno("file-publish-sync"); }', pattern: 'injected native publish fsync EIO' },
  { id: 'later-valid-witness-adopted', file: schema,
    from: '!sameRecord(published.pending, before.pending ?? before.current) || published.current.bytes !== expectedCurrent',
    to: 'published.current.bytes !== expectedCurrent', pattern: 'a later valid pending witness after claim' },
  { id: 'pending-warning-lost', file: schema,
    from: 'needsUpgrade: Boolean(pending || current.needsUpgrade)',
    to: 'needsUpgrade: Boolean(current?.needsUpgrade)', pattern: 'lost flush confirmation' },
  { id: 'readonly-discovery-writes', file: observer, from: 'const snapshots = await scratchTopics.list(workspace)',
    to: 'await scratchTopics.normalizeDirectoryIdentities(workspace)\n    const snapshots = await scratchTopics.list(workspace)', pattern: 'cold write-before ENOSPC' },
  { id: 'physical-path-mints-identity', file: addresses, from: 'if (topic.readError && !topic.identityDirectoryPath)',
    to: 'if (topic.readError && !topic.identityDirectoryPath && !topic.physicalDirectoryPath)', pattern: 'invalid wrong-root' },
  { id: 'cold-mote-classification-lost', file: observer,
    from: "kind: snapshot.id === PMO_TEAMS_TOPIC_ID || snapshot.soul !== undefined || snapshot.moteArchive !== undefined ? 'mote' : snapshot.readError ? 'unknown' : space?.kind === 'topic' ? 'topic' : 'unknown'",
    to: "kind: snapshot.readError ? 'unknown' : space?.kind === 'mote' ? 'mote' : space?.kind === 'topic' ? 'topic' : 'unknown'", pattern: 'cold write-before ENOSPC' },
  { id: 'startup-holds-healthy-input', file: ipc, from: 'if (scratchForIdentity) void Promise.resolve().then(() => args.scratchTopics.normalizeDirectoryIdentities(scratchForIdentity))',
    to: 'if (scratchForIdentity) await Promise.resolve().then(() => args.scratchTopics.normalizeDirectoryIdentities(scratchForIdentity))', pattern: 'executes the original IPC startup' }
]
const checks = [
  { symbol: 'nativeFilePublication', definition: nativeSource, caller: schema, anchor: "runFilePublication('--file-publish'" },
  { symbol: 'nativeFileConfirmation', definition: nativeSource, caller: schema, anchor: "runFilePublication('--file-confirm'" },
  { symbol: 'readDirectoryIdentity', definition: schema, caller: directories, anchor: 'await readDirectoryIdentity(' },
  { symbol: 'normalizeDirectoryIdentity', definition: schema, caller: scratch, anchor: 'await normalizeDirectoryIdentity(' },
  { symbol: 'normalizeDirectoryIdentities', definition: scratch, caller: ipc, anchor: 'args.scratchTopics.normalizeDirectoryIdentities(' },
  { symbol: 'retainDirectoryIdentity', definition: schema, caller: 'apps/desktop/scripts/migrate-topic-directories.mjs', anchor: 'await retainDirectoryIdentity(' },
  { symbol: 'observeClientRpcSnapshot', definition: observer, caller: ipc, anchor: 'observeClientRpcSnapshot(' },
  { symbol: 'originalTopicAddress', definition: addresses, caller: 'apps/desktop/src/renderer/src/components/SpaceTopicsTree.tsx', anchor: 'originalTopicAddress(' }
]
const files = [...new Set([schema, 'apps/desktop/src/main/scratch-directory-identity.d.mts', scratch, directories, addresses,
  observer, ipc, test, config, 'apps/desktop/native/workspace-move.c', 'apps/desktop/test/topic-directory-migration.native.test.mjs',
  'apps/desktop/scripts/migrate-topic-directories.mjs', 'apps/desktop/scripts/verify-topic-directory-migration-mutations.mjs',
  'apps/desktop/scripts/verify-mote-topic-directories-mutations.mjs', 'apps/desktop/scripts/verify-mote-directory-identity.mjs', ...checks.flatMap(check => [check.definition, check.caller])])]
const originals = Object.fromEntries(await Promise.all(files.map(async file => [file, await readFile(join(base, file))])))
const hash = value => createHash('sha256').update(value).digest('hex')
const receipt = { passed: false, source: Object.fromEntries(files.map(file => [file, hash(originals[file])])), callers: [], runs: [], mutations: [], native: null,
  boundary: 'Actual ScratchTopics, WorkspaceFiles and public service over a private Unix socket; two fresh actual Source CLI processes. Real private native directory exchange, ongoing cwd readers, assets, Git and restart. Source IPC startup statements executed without a user App; no live user Agent/Run, package, install, or full UI restart claim.', userDataTouched: false }
async function run(label, args, cwd = isolated, environment = {}) {
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...environment }, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''; child.stdout.on('data', bytes => { log += bytes }); child.stderr.on('data', bytes => { log += bytes })
  const deadline = setTimeout(() => child.kill('SIGKILL'), 60_000)
  const result = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal })) })
  clearTimeout(deadline); await writeFile(join(attempt, label + '.log'), log)
  const row = { label, command: [process.execPath, ...args.map(arg => arg.startsWith(base) ? relative(base, arg) : arg)], ...result,
    log: label + '.log', logSha256: hash(log) }
  receipt.runs.push(row); assert.equal(result.signal, null, 'Termination is not evidence: ' + label)
  return { ...row, text: log }
}
function green(run, minimum) {
  assert.equal(run.code, 0, run.text.slice(-7000))
  const matches = [...run.text.matchAll(/Tests\s+(\d+) passed/g), ...run.text.matchAll(/pass (\d+)\b/g)]
  assert.ok(matches.some(match => Number(match[1]) >= minimum), 'Nonempty selected behavior assertions required: ' + run.label)
}
try {
  await mkdir(isolated)
  for (const path of ['apps/desktop/src/main', 'apps/desktop/src/shared', 'apps/desktop/test/fixtures', 'packages/core/src', 'packages/core/test/helpers'])
    await cp(join(base, path), join(isolated, path), { recursive: true })
  for (const path of ['apps/desktop/src/renderer/src/lib/scratch-topic-snapshots.ts', 'apps/desktop/src/preload/index.ts', test, 'apps/desktop/test/scratch-topic-directories.test.ts', 'apps/desktop/test/rpc-client-observations.test.ts',
    'apps/desktop/test/mote-avatar-assets.test.ts', 'apps/desktop/test/mote-archive-service.test.ts', 'apps/desktop/test/mote-primary-directory.test.ts',
    config, 'apps/desktop/scripts/fixtures/mote-navigation-footer/vitest.owning.config.mts', 'apps/desktop/scripts/migrate-topic-directories.mjs',
    'apps/desktop/native/workspace-move.c', 'apps/desktop/scripts/build-workspace-move-helper.mjs', 'packages/core/package.json', 'apps/desktop/package.json', 'vitest.setup.ts', 'tsconfig.base.json']) {
    await mkdir(dirname(join(isolated, path)), { recursive: true }); await cp(join(base, path), join(isolated, path))
  }
  for (const path of ['node_modules', 'apps/desktop/node_modules', 'packages/core/node_modules',
    'packages/core/vendor', 'packages/demand', 'packages/layout', 'packages/client-ui']) {
    await mkdir(dirname(join(isolated, path)), { recursive: true }); await symlink(join(base, path), join(isolated, path))
  }
  await mkdir(join(isolated, 'apps/desktop/resources/bin'), { recursive: true })
  await cp(join(base, 'apps/desktop/resources/bin/agentmux-workspace-move'), join(isolated, 'apps/desktop/resources/bin/agentmux-workspace-move'))
  await writeFile(join(isolated, 'package.json'), '{"type":"module"}')
  for (const check of checks) {
    assert.notEqual(check.definition, check.caller)
    const line = originals[check.caller].toString().split('\n').findIndex(line => line.includes(check.anchor) && !line.trim().startsWith('import '))
    assert.ok(line >= 0, 'An actual external production caller is required: ' + check.symbol)
    receipt.callers.push({ ...check, line: line + 1 })
  }
  assert.ok(receipt.callers.length > 0)
  const vitest = [join(base, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, '--maxWorkers=1', '--reporter=verbose']
  green(await run('owning-baseline', vitest, isolated, { AGENTMUX_DIRECTORY_IDENTITY_PROOF: join(attempt, 'loaded-production.ndjson') }), 59)
  const loaded = (await readFile(join(attempt, 'loaded-production.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  receipt.loadedProduction = [...new Map(loaded.map(row => [row.consumer + ':' + row.file, row])).values()]
  for (const consumer of ['actual-vite-module', 'actual-source-cli-bundle']) assert.ok(receipt.loadedProduction.some(row => row.consumer === consumer && row.file.startsWith('packages/core/src/')), 'Nonempty actual Core imports required: ' + consumer)
  for (const variant of variants) {
    const original = originals[variant.file].toString(); assert.equal(original.split(variant.from).length, 2, 'One exact mutation anchor: ' + variant.id)
    const args = [...vitest, test, '-t', variant.pattern], changed = original.replace(variant.from, variant.to)
    await writeFile(join(isolated, variant.file), changed)
    if (variant.file === nativeSource) { const compiled = await run(variant.id + '-compile-red', ['apps/desktop/scripts/build-workspace-move-helper.mjs']); assert.equal(compiled.code, 0, compiled.text) }
    let red
    try {
      red = await run(variant.id + '-red', args)
      assert.notEqual(red.code, 0, 'The actual production mutant survived: ' + variant.id)
      assert.match(red.text, /AssertionError:/, 'Load errors/timeouts are not behavior RED: ' + variant.id)
      assert.doesNotMatch(red.text, /No test files found|Cannot find module|Cannot find package|Failed to resolve import|SyntaxError:/)
      assert.ok(red.text.includes(variant.pattern), 'The original selected assertion must be present')
    } finally {
      await writeFile(join(isolated, variant.file), originals[variant.file])
      if (variant.file === nativeSource) { const compiled = await run(variant.id + '-compile-restored', ['apps/desktop/scripts/build-workspace-move-helper.mjs']); assert.equal(compiled.code, 0, compiled.text) }
    }
    const restored = await run(variant.id + '-restored', args); green(restored, 1)
    receipt.mutations.push({ id: variant.id, file: variant.file, mutatedSha256: hash(changed), redLog: red.log, restoredLog: restored.log,
      redExit: red.code, restoredExit: restored.code })
    console.log(variant.id + ': assertion RED / restored GREEN')
  }
  const native = await run('native-original', ['--test', '--test-reporter=spec', 'apps/desktop/test/topic-directory-migration.native.test.mjs'], base)
  green(native, 10)
  receipt.native = await runTopicDirectoryMigrationMutations({ repository: base, outputDirectory: attempt })
  const require = createRequire(join(base, 'package.json')), ts = require('typescript')
  const paths = {}
  for (const name of ['core', 'demand', 'layout', 'client-ui']) {
    const manifest = JSON.parse(await readFile(join(base, 'packages', name, 'package.json'), 'utf8'))
    for (const [key, value] of Object.entries(manifest.exports)) {
      let target = typeof value === 'string' ? value : name === 'client-ui' ? value.browser : value.import
      if (!target || target.endsWith('.json')) continue
      if (name === 'core') target = target.replace('./dist/', './src/').replace(/\.js$/, '.ts')
      else if (name !== 'client-ui') target = target.replace('./dist/', './').replace(/\.js$/, '.ts')
      paths['@agentmux/' + name + (key === '.' ? '' : key.slice(1))] = ['packages/' + name + '/' + target.replace(/^\.\//, '')]
    }
  }
  const options = ts.convertCompilerOptionsFromJson({ target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler',
    noEmit: true, strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, skipLibCheck: true,
    esModuleInterop: true, resolveJsonModule: true, baseUrl: '.', paths, types: ['node'] }, base)
  const program = ts.createProgram([schema.replace(/\.mjs$/, '.d.mts'), scratch, directories, addresses, observer].map(file => join(base, file)), options.options)
  const diagnostics = [...options.errors, ...ts.getPreEmitDiagnostics(program)]
  const sourceFiles = program.getSourceFiles().map(file => relative(base, file.fileName))
  for (const file of [scratch, directories, addresses, observer]) assert.ok(sourceFiles.includes(file), 'Real owning strict graph must load ' + file)
  receipt.types = { scope: 'Original metadata/ScratchTopics/spatial/public observation owner graph, public current Source exports. IPC schedule graph excluded; actual startup statements are independently exercised.',
    strict: true, diagnosticCount: diagnostics.length, sources: sourceFiles, sourceHashes: Object.fromEntries(await Promise.all(sourceFiles.filter(file => !file.startsWith('../') && !file.includes('node_modules/') && !file.startsWith('packages/core/vendor/')).map(async file => [file, hash(await readFile(join(base, file)))]))), errors: diagnostics.map(item => ts.flattenDiagnosticMessageText(item.messageText, ' ')) }
  assert.equal(diagnostics.length, 0, receipt.types.errors.join('\n'))
  receipt.passed = true
} catch (error) { receipt.error = error.stack; process.exitCode = 1 }
finally {
  receipt.sourceChanges = []
  for (const file of files) if (hash(await readFile(join(base, file))) !== receipt.source[file]) receipt.sourceChanges.push(file)
  if (receipt.sourceChanges.length) { receipt.passed = false; receipt.error = 'The bound owning candidate changed during verification'; process.exitCode = 1 }
  await rm(isolated, { recursive: true, force: true }); receipt.privateSourceRemoved = true
  await writeFile(join(attempt, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: receipt.passed, receipt: relative(base, join(attempt, 'receipt.json')) }))
}
