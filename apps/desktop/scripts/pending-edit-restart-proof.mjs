import { fixturePath as _hygiene_fixturePath } from "./lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'

const root = resolve(import.meta.dirname, '../../..'), exec = promisify(execFile), require = createRequire(import.meta.url)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const packages = ['core', 'demand', 'client-ui', 'layout', 'relay']

/** A new restart mode reuses the real harness; only its build tree is private. */
export async function runPendingEditRestart(arguments_, mode = 'pending-edit') {
  assert.ok(['pending-edit', 'steer-recovery'].includes(mode), 'Only the owning private proof modes may use this build')
  const steerRecovery = mode === 'steer-recovery'
  const diagnosticOnly = steerRecovery && arguments_.includes('--steer-recovery-diagnostic')
  const typedCrossCore = steerRecovery && arguments_.includes('--typed-response-cross-core')
  const typedFirstHook = steerRecovery && arguments_.includes('--typed-response-first-hook')
  const startupFirstSend = steerRecovery && arguments_.includes('--startup-first-send')
  const startupRestoredOnly = steerRecovery && arguments_.includes('--startup-restored-first-send')
  const finalQualification = steerRecovery && arguments_.includes('--steer-recovery-final')
  const startupQualification = startupFirstSend || startupRestoredOnly
  assert.ok(!(startupFirstSend && startupRestoredOnly), 'Startup proof triggers have distinct qualification scopes')
  assert.ok(!finalQualification || !(startupQualification || diagnosticOnly || typedCrossCore), 'Final GUI qualification has a distinct Source and Native scope')
  assert.ok(!startupQualification || !(diagnosticOnly || typedCrossCore), 'Startup first Send is a distinct Native qualification')
  assert.ok(!typedFirstHook || typedCrossCore, 'First-Hook qualification must use the two-Core Native mode')
  assert.ok(!(diagnosticOnly && typedCrossCore), 'Distinct bounded proof modes cannot be combined')
  const environmentKey = steerRecovery ? 'AGENTMUX_STEER_RECOVERY_BUILD_RECEIPT' : 'AGENTMUX_PENDING_EDIT_BUILD_RECEIPT'
  const worker = steerRecovery ? 'steer-recovery-native-proof.mjs' : 'verify-workbench-persistence-restart.mjs'
  const resultField = finalQualification ? 'steerRecoveryFinal' : startupRestoredOnly ? 'startupRestoredFirstSend' : startupFirstSend ? 'startupFirstSend' : typedFirstHook ? 'typedResponseFirstHook' : typedCrossCore ? 'typedResponseCrossCore' : steerRecovery ? 'steerRecovery' : 'pendingEdit'
  const evidence = join(root, steerRecovery ? '.tmp/steer-recovery-restart' : '.tmp/composer-pending-edit-restart', String(globalThis.crypto.randomUUID()))
  // The inner real harness has Unix sockets below this tree. macOS's per-user
  // tmpdir prefix would exceed sockaddr_un's path limit after that nesting.
  const privateRoot = await realpath(await mkdtemp(join(process.platform === 'darwin' ? _hygiene_fixturePath("tmp") : tmpdir(), steerRecovery ? 'amx-sr-' : 'amx-pe-')))
  await mkdir(evidence, { recursive: true })
  const requestedReceipt = arguments_.find(value => value.startsWith('--receipt-path='))?.slice('--receipt-path='.length)
  const receiptPath = requestedReceipt ? resolve(root, requestedReceipt) : join(evidence, 'receipt.json')
  const buildReceiptPath = join(evidence, 'build.json')
  const sourceArchivePath = join(evidence, 'source.tar')
  const requestedSourceRef = arguments_.find(value => value.startsWith('--' + mode + '-source-ref='))?.slice(('--' + mode + '-source-ref=').length)
  assert.ok(!finalQualification || requestedSourceRef, 'Final GUI qualification requires an explicit complete Main SourceRef')
  const sourceCommit = (await exec('git', ['rev-parse', '--verify', '--end-of-options', (requestedSourceRef ?? 'HEAD') + '^{commit}'], { cwd: root })).stdout.trim()
  const mainAtCapture = finalQualification ? (await exec('git', ['rev-parse', 'refs/heads/main'], { cwd: root })).stdout.trim() : undefined
  if (finalQualification) assert.equal(sourceCommit, mainAtCapture, 'Final GUI qualification consumes the full current Main, never an older candidate')
  const t010ManifestArgument = arguments_.find(value => value.startsWith('--startup-first-send-product-manifest='))?.slice('--startup-first-send-product-manifest='.length)
  const t010ManifestSha = arguments_.find(value => value.startsWith('--startup-first-send-product-manifest-sha='))?.slice('--startup-first-send-product-manifest-sha='.length)
  assert.ok(!finalQualification || !t010ManifestArgument && !t010ManifestSha, 'Final GUI qualification prohibits product source overlays')
  assert.ok(!t010ManifestArgument && !t010ManifestSha || startupQualification && requestedSourceRef && t010ManifestArgument && /^[0-9a-f]{64}$/.test(t010ManifestSha),
    'A T010 product candidate requires its bounded Native mode, exact full Main SourceRef and manifest hash')
  const build = { schema: 'agentmux.pending-edit-restart-build.v1', privateRoot, sources: {}, compiled: {},
    sharedSourceWritten: false, userRunTouched: false, sourceCommit,
    sourceMode: requestedSourceRef ? 'exact-git-archive-with-test-only-overlay' : 'captured-working-source', requestedSourceRef: requestedSourceRef ?? null, ...(finalQualification ? { mainAtCapture, productOverlayProhibited: true } : {}) }
  let failure, outcome
  const record = async (directory, destination) => {
    for (const file of await readdir(directory, { recursive: true, withFileTypes: true })) if (file.isFile()) {
      const path = join(file.parentPath, file.name)
      destination[relative(privateRoot, path)] = sha(await readFile(path))
    }
  }
  const command = async (name, executable, args, cwd) => {
    try {
      const reply = await exec(executable, args, { cwd, maxBuffer: 16 * 1024 * 1024,
        // pnpm 11 otherwise installs while running exec in a copied tree. This proof
        // deliberately consumes installed dependencies and never mutates them.
        env: { ...process.env, pnpm_config_verify_deps_before_run: 'false' } })
      await writeFile(join(evidence, name + '.log'), reply.stdout + reply.stderr)
    } catch (error) {
      await writeFile(join(evidence, name + '.log'), (error.stdout ?? '') + (error.stderr ?? ''))
      throw error
    }
  }
  try {
    if (requestedSourceRef) {
      const archive = sourceArchivePath
      await exec('git', ['archive', '--format=tar', '--output=' + archive, sourceCommit], { cwd: root })
      await exec('tar', ['-xf', archive, '-C', privateRoot])
      await rm(archive)
      // Overlay only the two owning proof scripts from this execution tree;
      // all product code comes from the exact committed source.
      for (const path of ['apps/desktop/scripts/verify-workbench-persistence-restart.mjs', 'apps/desktop/scripts/pending-edit-restart-proof.mjs', ...(steerRecovery ? ['apps/desktop/scripts/steer-recovery-native-proof.mjs'] : [])])
        await cp(join(root, path), join(privateRoot, path))
    }
    if (t010ManifestArgument) {
      // Product ownership remains Core's exact approved T010 slice. Apply only to the
      // private complete Main archive, before Source capture and the actual build.
      const manifestPath = resolve(root, t010ManifestArgument), manifestBytes = await readFile(manifestPath)
      assert.equal(sha(manifestBytes), t010ManifestSha)
      const manifest = JSON.parse(manifestBytes)
      assert.equal(manifest.schema, 'agentmux.t010.urgent-source.v1')
      const allowed = ['packages/core/src/agent-provider.ts', 'packages/core/src/client.ts', 'packages/core/src/prompt-submission.ts',
        'packages/core/src/providers/codex-prompt-execution-evidence.ts', 'packages/core/src/providers/codex.ts',
        'packages/core/src/providers/codex-prompt-transport-preparation.ts', 'packages/core/test/initial-transport-preparation.test.ts',
        'packages/core/test/initial-transport-provider.test.ts', 'packages/core/scripts/initial-transport-preparation.vitest.config.mts',
        'packages/core/scripts/verify-initial-transport-preparation.mjs']
      assert.deepEqual(Object.keys(manifest.files).sort(), allowed.sort())
      await exec('git', ['merge-base', '--is-ancestor', manifest.base, sourceCommit], { cwd: root })
      const patchBytes = await readFile(join(dirname(manifestPath), 'own.patch'))
      assert.equal(sha(patchBytes), manifest.patchSha256)
      const patchPaths = [...patchBytes.toString('utf8').matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)]
      assert.equal(patchPaths.length, allowed.length)
      assert.ok(patchPaths.every(match => match[1] === match[2] && allowed.includes(match[1])))
      assert.deepEqual(patchPaths.map(match => match[1]).sort(), allowed)
      const frozenManifest = join(evidence, 't010-product-manifest.json'), frozenPatch = join(evidence, 't010-product.own.patch')
      await writeFile(frozenManifest, manifestBytes); await writeFile(frozenPatch, patchBytes)
      await exec('git', ['apply', '--check', frozenPatch], { cwd: privateRoot })
      await exec('git', ['apply', frozenPatch], { cwd: privateRoot })
      for (const path of allowed) assert.equal(sha(await readFile(join(privateRoot, path))), manifest.files[path], 'Exact Core-owned T010 candidate: ' + path)
      build.sourceMode = 'exact-full-Main-archive-with-declared-Core-owned-T010-and-test-only-overlay'
      build.t010ProductCandidate = { manifest: frozenManifest, manifestSha256: sha(manifestBytes), patch: frozenPatch,
        patchSha256: sha(patchBytes), base: manifest.base, fullMainSnapshot: sourceCommit, sources: manifest.files,
        boundary: 'Only the separately Source-qualified T010 own delta is applied privately; no T008 product or shared-tree mutation.' }
    }
    if (diagnosticOnly) {
      const probeSource = join(root, ".tmp/message-tool-compact-feedback-fixture/first-send-prepare-probe/prepare-call-probe.mjs")
      const bytes = await readFile(probeSource)
      assert.equal(sha(bytes), '0d51f7b83a56b1e73065fa3c40a2b52b51f6cb0fad9da57c3862057f536d0f0b')
      const probePath = join(privateRoot, '.restart-proof-prepare-call-probe.mjs')
      await writeFile(probePath, bytes)
      build.diagnosticProbe = { path: probePath, source: probeSource, sha256: sha(bytes), boundary: 'Test-only host preload; product source/dist unchanged; this run qualifies diagnosis only.' }
    }
    const directories = ['apps/desktop/src', 'apps/desktop/browser-extension', 'apps/desktop/scripts', 'apps/desktop/brand', 'apps/desktop/native', 'apps/desktop/resources', 'apps/host/src',
      'packages/core/src', 'packages/core/scripts', 'packages/core/bin', 'packages/core/vendor',
      'packages/demand/src', 'packages/demand/bin', 'packages/relay/src', 'packages/client-ui/src', 'packages/layout/src', 'patches']
    for (const directory of directories) {
      if (!requestedSourceRef) {
        try { await cp(join(root, directory), join(privateRoot, directory), { recursive: true }) }
        catch (error) { if (!(directory === 'apps/desktop/brand' && error.code === 'ENOENT')) throw error }
      }
      try { await record(join(privateRoot, directory), build.sources) }
      catch (error) { if (!(directory === 'apps/desktop/brand' && error.code === 'ENOENT')) throw error }
    }
    for (const path of ['package.json', 'tsconfig.base.json', 'tsconfig.shared.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'apps/desktop/package.json', 'apps/desktop/electron.vite.config.ts',
      'apps/host/package.json', ...packages.flatMap(pkg => ['package.json', 'tsconfig.json', 'tsconfig.build.json'].map(name => 'packages/' + pkg + '/' + name))]) {
      try { const bytes = await readFile(join(requestedSourceRef ? privateRoot : root, path)); await mkdir(dirname(join(privateRoot, path)), { recursive: true }); await writeFile(join(privateRoot, path), bytes); build.sources[path] = sha(bytes) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    // Shadow only workspace dependencies. Ordinary installed packages are read-only shared inputs;
    // Desktop Main and every private Core consumer resolve the compiled private Core, never stale dist.
    for (const directory of ['node_modules', 'apps/desktop/node_modules', ...packages.map(pkg => 'packages/' + pkg + '/node_modules')]) {
      await mkdir(join(privateRoot, directory, '@agentmux'), { recursive: true })
      for (const entry of await readdir(join(root, directory))) {
        if (entry === '@agentmux') continue
        if (['.pnpm', '.pnpm_patches', '.vite', '.vite-temp'].includes(entry)) {
          await mkdir(join(privateRoot, directory, entry), { recursive: true }); continue
        }
        if (entry === '.bin') {
          await cp(join(root, directory, entry), join(privateRoot, directory, entry), { recursive: true, dereference: true }); continue
        }
        if (['.modules.yaml', '.pnpm-workspace-state-v1.json'].includes(entry)) {
          await cp(join(root, directory, entry), join(privateRoot, directory, entry)); continue
        }
        if (entry.startsWith('@')) {
          await mkdir(join(privateRoot, directory, entry), { recursive: true })
          for (const pkg of await readdir(join(root, directory, entry))) {
            await symlink(join(root, directory, entry, pkg), join(privateRoot, directory, entry, pkg))
          }
        } else await symlink(join(root, directory, entry), join(privateRoot, directory, entry))
      }
      for (const pkg of packages) await symlink(join(privateRoot, 'packages', pkg), join(privateRoot, directory, '@agentmux', pkg), 'dir')
    }
    if (steerRecovery) {
      // This candidate's vendored SDK owns both its runtime bundle and TypeScript surface.
      // Sharing the installed SDK can mix a newer/older peer dependency with this archive.
      const artifactDirectory = join(privateRoot, 'packages/core/vendor/ctxmux', process.platform + '-' + process.arch)
      const manifestPath = join(artifactDirectory, 'manifest.json')
      const manifestBytes = await readFile(manifestPath)
      const manifest = JSON.parse(manifestBytes)
      const contract = JSON.parse(await readFile(join(privateRoot, 'packages/core/src/ctxmux-artifact-contract.json'), 'utf8'))
      assert.equal(sha(manifestBytes), contract.manifests[process.platform + '-' + process.arch])
      const archive = join(artifactDirectory, manifest.sdk.archive.path)
      const archiveBytes = await readFile(archive)
      assert.equal(sha(archiveBytes), manifest.sdk.archive.sha256)
      assert.equal(archiveBytes.byteLength, manifest.sdk.archive.bytes)
      const unpacked = join(privateRoot, '.restart-proof-sdk')
      await mkdir(unpacked)
      await exec('tar', ['-xzf', archive, '-C', unpacked])
      const sdk = join(unpacked, 'package')
      const packageJson = JSON.parse(await readFile(join(sdk, 'package.json'), 'utf8'))
      await symlink(join(privateRoot, 'packages/core/node_modules'), join(sdk, 'node_modules'), 'dir')
      const consumerEntries = {}
      for (const directory of ['node_modules', 'apps/desktop/node_modules', ...packages.map(pkg => 'packages/' + pkg + '/node_modules')]) {
        const scope = join(privateRoot, directory, '@ctxmux')
        await mkdir(scope, { recursive: true })
        const sdkLink = join(scope, 'sdk')
        await rm(sdkLink, { recursive: true, force: true })
        await symlink(sdk, sdkLink, 'dir')
        const consumer = join(privateRoot, directory, 'restart-proof-consumer.mjs')
        await writeFile(consumer, `import{fileURLToPath}from'node:url';import * as sdk from '@ctxmux/sdk';console.log(JSON.stringify({entry:fileURLToPath(import.meta.resolve('@ctxmux/sdk')),loaded:typeof sdk.CtxmuxClient==='function'}));\n`)
        const resolved = JSON.parse((await exec(process.execPath, [consumer], { cwd: privateRoot })).stdout)
        await rm(consumer)
        const entry = await realpath(resolved.entry)
        assert.equal(resolved.loaded, true)
        assert.equal(entry, join(sdk, packageJson.exports['.'].import))
        consumerEntries[directory] = { entry: relative(privateRoot, entry), sha256: sha(await readFile(entry)) }
      }
      const types = join(sdk, packageJson.exports['.'].types)
      assert.equal(packageJson.name, '@ctxmux/sdk')
      assert.equal(packageJson.version, manifest.sdk.version)
      build.ctxmuxSdk = { manifestSha256: sha(manifestBytes), sourceCommit: manifest.source.commit,
        archiveSha256: sha(archiveBytes), archive: relative(privateRoot, archive),
        packageSha256: sha(await readFile(join(sdk, 'package.json'))),
        types: relative(privateRoot, types), typesSha256: sha(await readFile(types)), consumerEntries,
        reason: 'Every private consumer resolves the exact candidate manifest SDK; shared dependency links remain untouched.' }
    }
    // The archive's lockfile owns dependency identity; concurrent root links can be stale.
    // Resolve only installed exact packages and write links solely below the private build.
    const yaml = require(require.resolve('yaml', { paths: [join(root, 'packages/core')] }))
    const lock = yaml.parse(await readFile(join(privateRoot, 'pnpm-lock.yaml'), 'utf8'))
    const desktopPackage = JSON.parse(await readFile(join(privateRoot, 'apps/desktop/package.json'), 'utf8'))
    const installedPool = await readdir(join(root, 'node_modules/.pnpm'))
    build.fixtureInstalledDependencies = []
    for (const [name, specification] of Object.entries(desktopPackage.dependencies)) {
      if (specification.startsWith('workspace:')) continue
      const locked = lock.importers?.['apps/desktop']?.dependencies?.[name]?.version
      assert.equal(typeof locked, 'string', 'Candidate dependency must have its actual lockfile resolution: ' + name)
      const version = locked.split('(')[0]
      const privateLink = join(privateRoot, 'apps/desktop/node_modules', name)
      let packageBytes
      try { packageBytes = await readFile(join(privateLink, 'package.json')) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      if (packageBytes && JSON.parse(packageBytes).version === version) continue
      const prefix = name.replace('/', '+') + '@' + version
      const matches = installedPool.filter(entry => entry === prefix || entry.startsWith(prefix + '_'))
      assert.equal(matches.length, 1, 'Candidate dependency requires one installed exact resolution: ' + name)
      const installed = join(root, 'node_modules/.pnpm', matches[0], 'node_modules', name)
      packageBytes = await readFile(join(installed, 'package.json'))
      assert.equal(JSON.parse(packageBytes).version, version)
      await mkdir(dirname(privateLink), { recursive: true })
      await rm(privateLink, { recursive: true, force: true })
      await symlink(installed, privateLink, 'dir')
      build.fixtureInstalledDependencies.push({ name, specification, locked, path: installed,
        packageSha256: sha(packageBytes),
        reason: 'The exact candidate lockfile resolution is linked only in the private build; shared links remain unchanged.' })
    }
    const bannerPath = 'apps/desktop/resources/settings-banner.png'
    try { await readFile(join(privateRoot, bannerPath)) }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      const { stdout } = await exec('git', ['show', build.sourceCommit + ':' + bannerPath], { cwd: root, encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 })
      await writeFile(join(privateRoot, bannerPath), stdout)
      build.fixtureResourceSnapshot = { path: bannerPath, sourceCommit: build.sourceCommit, sha256: sha(stdout),
        reason: 'Concurrent shared-tree resource deletion while production imports still reference this bitmap; private fixture only, no shared restoration.' }
    }
    await command('private-demand-build', process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'packages/demand/tsconfig.build.json'], privateRoot)
    await command('private-relay-build', process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'packages/relay/tsconfig.json'], privateRoot)
    await command('private-core-build', process.execPath, [join(privateRoot, 'packages/core/scripts/build.mjs')], privateRoot)
    await record(join(privateRoot, 'packages/demand/dist'), build.compiled)
    await record(join(privateRoot, 'packages/relay/dist'), build.compiled)
    build.workspaceConsumers = {}
    for (const directory of ['packages/core/node_modules', 'apps/desktop/node_modules']) {
      const consumer = join(privateRoot, directory, 'restart-proof-workspace-consumer.mjs')
      await writeFile(consumer, `import{fileURLToPath}from'node:url';await import('@agentmux/demand/goals');await import('@agentmux/relay');console.log(JSON.stringify(Object.fromEntries(['@agentmux/demand/goals','@agentmux/relay'].map(name=>[name,fileURLToPath(import.meta.resolve(name))]))));\n`)
      const resolved = JSON.parse((await exec(process.execPath, [consumer], { cwd: privateRoot })).stdout)
      await rm(consumer)
      build.workspaceConsumers[directory] = {}
      for (const [name, path] of Object.entries(resolved)) {
        const pkg = name === '@agentmux/relay' ? 'relay' : 'demand', subpath = name === '@agentmux/relay' ? '.' : './goals'
        const metadata = JSON.parse(await readFile(join(privateRoot, 'packages', pkg, 'package.json'), 'utf8'))
        const entry = await realpath(path)
        assert.equal(entry, join(privateRoot, 'packages', pkg, metadata.exports[subpath].import))
        build.workspaceConsumers[directory][name] = { entry: relative(privateRoot, entry), sha256: sha(await readFile(entry)) }
      }
    }
    const brandScript = join(privateRoot, 'apps/desktop/scripts/build-brand-assets.mjs')
    try { await readFile(brandScript); await command('private-brand-build', process.execPath, [brandScript], privateRoot) }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      build.brandInputs = { reason: 'This exact committed source has no brand derivation script; its tracked consumer bitmaps are used unchanged.' }
    }
    await command('private-workspace-helper-build', process.execPath, [join(privateRoot, 'apps/desktop/scripts/build-workspace-move-helper.mjs')], privateRoot)
    const closurePath = join(evidence, 'desktop-source-closure.json')
    const config = join(privateRoot, 'apps/desktop/restart-proof.vite.config.mjs')
    await writeFile(config, `import actual from './electron.vite.config.ts';import{readFile,writeFile}from'node:fs/promises';import{createHash}from'node:crypto';import{relative}from'node:path';
const root=${JSON.stringify(privateRoot)},loaded={};
const plugin=()=>({name:'private-restart-source-identity',enforce:'pre',async load(id){if(id.startsWith(root+'/')&&!id.includes('/node_modules/')&&!id.includes('?')){try{loaded[relative(root,id)]=createHash('sha256').update(await readFile(id)).digest('hex')}catch{}}},async closeBundle(){await writeFile(${JSON.stringify(closurePath)},JSON.stringify(loaded,null,2))}});
export default Object.fromEntries(Object.entries(actual).map(([key,value])=>[key,{...value,plugins:[plugin(),...(value.plugins??[])]}]));\n`)
    await command('private-desktop-build', process.execPath, [join(root, 'apps/desktop/node_modules/electron-vite/bin/electron-vite.js'), 'build', '--config', config], join(privateRoot, 'apps/desktop'))
    build.desktopSourceClosure = JSON.parse(await readFile(closurePath, 'utf8'))
    for (const path of ['apps/desktop/src/main/index.ts', 'apps/desktop/src/preload/index.ts', 'apps/desktop/src/shared/contracts.ts', 'apps/desktop/src/renderer/src/lib/api.ts',
      'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx', 'apps/desktop/src/renderer/src/components/SessionMailbox.tsx']) {
      assert.equal(build.desktopSourceClosure[path], build.sources[path], 'Private Desktop consumed actual captured production source: ' + path)
    }
    await record(join(privateRoot, 'apps/desktop/out'), build.compiled)
    await record(join(privateRoot, 'packages/core/dist'), build.compiled)
    assert.ok(Object.keys(build.compiled).length > 100)
    await writeFile(buildReceiptPath, JSON.stringify(build, null, 2))
    const args = arguments_.filter(value => !value.startsWith('--receipt-path=') && !value.startsWith('--probe-root=') && !value.startsWith('--' + mode + '-source-ref=') && !value.startsWith('--startup-first-send-product-manifest=') && !value.startsWith('--startup-first-send-product-manifest-sha='))
    const lines = []
    const executionEnvironment = { ...process.env, [environmentKey]: buildReceiptPath }
    delete executionEnvironment.ELECTRON_RUN_AS_NODE
    outcome = await runProbeProcess(process.execPath, [join(privateRoot, 'apps/desktop/scripts', worker), ...args,
      '--probe-root=' + privateRoot, '--receipt-path=' + receiptPath], { cwd: privateRoot, temporaryRoot: privateRoot,
      env: executionEnvironment, timeoutMs: steerRecovery ? 300_000 : 130_000, onLine: line => lines.push(line) })
    await writeFile(join(evidence, 'restart.log'), lines.join('\n') + '\n')
    assert.equal(outcome.timedOut, false)
    assert.equal(outcome.exitCode, 0)
    const result = JSON.parse(await readFile(receiptPath, 'utf8'))
    assert.equal(result.passed, true); assert.equal(result[resultField]?.passed, true)
  } catch (error) { failure = error }
  finally {
    const differenceField = requestedSourceRef ? 'capturedSourceVsSharedWorkingAtCompletion' : 'sharedSourceChangesDuringProof'
    build[differenceField] = []
    for (const [path, captured] of Object.entries(build.sources)) {
      let current
      try { current = sha(await readFile(join(root, path))) } catch (error) { if (error.code !== 'ENOENT') throw error; current = null }
      if (current !== captured) build[differenceField].push({ path, captured, current })
    }
    assert.deepEqual(await listProbeProcesses(-1, privateRoot), [], 'Private restart leaves no processes in its build or fixture tree')
    await rm(privateRoot, { recursive: true, force: true }); build.privateRootRemoved = true
    // A failed extraction can leave the reproducible committed archive; it contains no Run or
    // unsaved data. Keep its exact sourceCommit and failure receipt, not a redundant cache.
    await rm(sourceArchivePath, { force: true })
    await writeFile(buildReceiptPath, JSON.stringify(build, null, 2))
    await writeFile(join(evidence, 'summary.json'), JSON.stringify({ schema: steerRecovery ? 'agentmux.steer-recovery-restart-proof.v1' : 'agentmux.pending-edit-restart-proof.v1', passed: !failure,
      receiptPath, buildReceiptPath, outcome, qualifiedScope: finalQualification ? 'Fresh-complete-Main-GUI-A-B-C-only' : startupRestoredOnly ? 'GUI-restored-first-Send-only' : startupFirstSend ? 'Native-initial-and-GUI-restored-first-Send-only' : typedFirstHook ? 'SDK-two-Core-first-Hook-Native-only' : typedCrossCore ? 'SDK-two-Core-Native-only' : diagnosticOnly ? 'first-Send-diagnostic-only' : mode, userRunTouched: false, sharedSourceWritten: false,
      failure: failure ? { name: failure.name, message: failure.message, stack: failure.stack } : null }, null, 2))
  }
  process.stdout.write(JSON.stringify({ mode: '--' + mode, passed: !failure, receiptPath, buildReceiptPath, evidence,
    failure: steerRecovery ? failure?.message.split('\n')[0] : failure?.message }) + '\n')
  return failure ? 1 : 0
}
