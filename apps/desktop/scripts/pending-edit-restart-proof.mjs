import { fixturePath as _hygiene_fixturePath } from "./lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
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
  assert.ok(['pending-edit', 'steer-recovery', 'prompt-preparation-stage', 'demand-collaboration', 'display-layout-set'].includes(mode), 'Only the owning private proof modes may use this build')
  const displayLayoutSet = mode === 'display-layout-set'
  const inactiveWindow = displayLayoutSet || arguments_.includes('--inactive-window')
  assert.ok(!inactiveWindow || mode === 'pending-edit' || displayLayoutSet, 'Non-activating windows belong only to their explicit private proofs')
  const demandCollaboration = mode === 'demand-collaboration'
  assert.ok(!displayLayoutSet || arguments_.every(a => a === '--display-layout-set' || a.startsWith('--receipt-path=') || a.startsWith('--probe-root=') || a.startsWith('--display-layout-set-source-ref=')), 'Display layout restoration is one bounded private restart scenario')
  const packages = inactiveWindow ? ['core', 'demand', 'client-ui', 'layout', 'relay', 'identity', 'git', 'diagnostic-evidence', 'connectors', ...(displayLayoutSet ? ['capsule'] : [])]
    : demandCollaboration ? ['core', 'demand', 'client-ui', 'layout', 'relay', 'identity', 'git'] : ['core', 'demand', 'client-ui', 'layout', 'relay']
  const steerRecovery = mode === 'steer-recovery', phaseCapture = mode === 'prompt-preparation-stage'
  assert.ok(!demandCollaboration || arguments_.every(a => a === '--demand-collaboration' || a.startsWith('--receipt-path=') || a.startsWith('--probe-root=') || a.startsWith('--demand-collaboration-source-ref=')), 'Demand collaboration has an explicit bounded test-only mode')
  assert.ok(!phaseCapture || !arguments_.some(a => a === '--steer-recovery' || a === '--pending-edit'), 'Finite phase capture has a distinct scope')
  assert.ok(!phaseCapture || arguments_.every(a => a === '--prompt-preparation-stage' || a.startsWith('--receipt-path=') || a.startsWith('--probe-root=') || a.startsWith('--prompt-preparation-stage-source-ref=')), 'Finite phase capture accepts only its bounded Source/receipt options')
  const diagnosticOnly = steerRecovery && arguments_.includes('--steer-recovery-diagnostic')
  const typedCrossCore = steerRecovery && arguments_.includes('--typed-response-cross-core')
  const typedFirstHook = steerRecovery && arguments_.includes('--typed-response-first-hook')
  const startupFirstSend = steerRecovery && arguments_.includes('--startup-first-send')
  const startupRestoredOnly = steerRecovery && arguments_.includes('--startup-restored-first-send')
  const finalQualification = steerRecovery && (arguments_.includes('--steer-recovery-final') || !(diagnosticOnly || typedCrossCore || startupFirstSend || startupRestoredOnly))
  const startupQualification = startupFirstSend || startupRestoredOnly
  assert.ok(!(startupFirstSend && startupRestoredOnly), 'Startup proof triggers have distinct qualification scopes')
  assert.ok(!finalQualification || !(startupQualification || diagnosticOnly || typedCrossCore), 'Final GUI qualification has a distinct Source and Native scope')
  assert.ok(!startupQualification || !(diagnosticOnly || typedCrossCore), 'Startup first Send is a distinct Native qualification')
  assert.ok(!typedFirstHook || typedCrossCore, 'First-Hook qualification must use the two-Core Native mode')
  assert.ok(!(diagnosticOnly && typedCrossCore), 'Distinct bounded proof modes cannot be combined')
  const environmentKey = displayLayoutSet ? 'AGENTMUX_DISPLAY_LAYOUT_SET_BUILD_RECEIPT' : demandCollaboration ? 'AGENTMUX_DEMAND_COLLABORATION_BUILD_RECEIPT' : phaseCapture ? 'AGENTMUX_PROMPT_PREPARATION_BUILD_RECEIPT' : steerRecovery ? 'AGENTMUX_STEER_RECOVERY_BUILD_RECEIPT' : 'AGENTMUX_PENDING_EDIT_BUILD_RECEIPT'
  const worker = displayLayoutSet ? 'workspace-layout-restore-restart-proof.mjs' : phaseCapture ? 'prompt-preparation-stage-native-proof.mjs' : steerRecovery ? 'steer-recovery-native-proof.mjs' : 'verify-workbench-persistence-restart.mjs'
  const resultField = displayLayoutSet ? 'displayLayoutSet' : demandCollaboration ? 'demandCollaboration' : phaseCapture ? 'promptPreparationStage' : finalQualification ? 'steerRecoveryFinal' : startupRestoredOnly ? 'startupRestoredFirstSend' : startupFirstSend ? 'startupFirstSend' : typedFirstHook ? 'typedResponseFirstHook' : typedCrossCore ? 'typedResponseCrossCore' : steerRecovery ? 'steerRecovery' : 'pendingEdit'
  const proofId = displayLayoutSet ? (await import('../../../packages/core/dist/object-id.js')).mintObjectId() : globalThis.crypto.randomUUID()
  const evidence = join(root, displayLayoutSet ? '.tmp/display-layout-set-restart' : demandCollaboration ? '.tmp/demand-collaboration-native' : phaseCapture ? '.tmp/prompt-preparation-stage' : steerRecovery ? '.tmp/steer-recovery-restart' : '.tmp/composer-pending-edit-restart', String(proofId))
  // The inner real harness has Unix sockets below this tree. macOS's per-user
  // tmpdir prefix would exceed sockaddr_un's path limit after that nesting.
  const privateRoot = await realpath(await mkdtemp(join(process.platform === 'darwin' ? _hygiene_fixturePath("tmp") : tmpdir(), displayLayoutSet ? 'amx-ls-' : demandCollaboration ? 'amx-dc-' : phaseCapture ? 'amx-ps-' : steerRecovery ? 'amx-sr-' : 'amx-pe-')))
  const privateHome = join(privateRoot, 'home')
  await mkdir(evidence, { recursive: true })
  const requestedReceipt = arguments_.find(value => value.startsWith('--receipt-path='))?.slice('--receipt-path='.length)
  const receiptPath = requestedReceipt ? resolve(root, requestedReceipt) : join(evidence, 'receipt.json')
  const buildReceiptPath = join(evidence, 'build.json')
  const inactiveWindowDirectory = join(evidence, 'inactive-windows')
  if (inactiveWindow) await mkdir(inactiveWindowDirectory, { recursive: true })
  const sourceArchivePath = join(evidence, 'source.tar')
  const requestedSourceRef = arguments_.find(value => value.startsWith('--' + mode + '-source-ref='))?.slice(('--' + mode + '-source-ref=').length) ?? (phaseCapture ? 'refs/heads/main' : undefined)
  assert.ok(!demandCollaboration || requestedSourceRef, 'Demand collaboration requires an immutable full integrated SourceRef')
  assert.ok(!phaseCapture || requestedSourceRef, 'Finite phase capture requires immutable complete SourceRef')
  assert.ok(!finalQualification || requestedSourceRef, 'Final GUI qualification requires an explicit complete Main SourceRef')
  const sourceCommit = (await exec('git', ['rev-parse', '--verify', '--end-of-options', (requestedSourceRef ?? 'HEAD') + '^{commit}'], { cwd: root })).stdout.trim()
  const mainAtCapture = finalQualification || demandCollaboration ? (await exec('git', ['rev-parse', 'refs/heads/main'], { cwd: root })).stdout.trim() : undefined
  if (finalQualification) assert.equal(sourceCommit, mainAtCapture, 'Final GUI qualification consumes the full current Main, never an older candidate')
  const t010ManifestArgument = arguments_.find(value => value.startsWith('--startup-first-send-product-manifest='))?.slice('--startup-first-send-product-manifest='.length)
  const t010ManifestSha = arguments_.find(value => value.startsWith('--startup-first-send-product-manifest-sha='))?.slice('--startup-first-send-product-manifest-sha='.length)
  assert.ok(!finalQualification || !t010ManifestArgument && !t010ManifestSha, 'Final GUI qualification prohibits product source overlays')
  assert.ok(!t010ManifestArgument && !t010ManifestSha || startupQualification && requestedSourceRef && t010ManifestArgument && /^[0-9a-f]{64}$/.test(t010ManifestSha),
    'A T010 product candidate requires its bounded Native mode, exact full Main SourceRef and manifest hash')
  const build = { schema: 'agentmux.pending-edit-restart-build.v1', privateRoot, sources: {}, compiled: {},
    sharedSourceWritten: false, userRunTouched: false, sourceCommit,
    sourceMode: requestedSourceRef ? 'exact-git-archive-with-test-only-overlay' : 'captured-working-source', requestedSourceRef: requestedSourceRef ?? null, ...(finalQualification || demandCollaboration ? { mainAtCapture, productOverlayProhibited: true } : {}), proofOverlays: {}, archive: null }
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
      build.archive = { sourceCommit, sha256: sha(await readFile(archive)), mode: 'complete-immutable-product-source-no-product-overlays' }
      await rm(archive)
      // Overlay only the two owning proof scripts from this execution tree;
      // all product code comes from the exact committed source.
      for (const path of ['apps/desktop/scripts/verify-workbench-persistence-restart.mjs', 'apps/desktop/scripts/pending-edit-restart-proof.mjs', ...(displayLayoutSet ? ['apps/desktop/scripts/workspace-layout-restore-restart-proof.mjs'] : []), ...(steerRecovery ? ['apps/desktop/scripts/steer-recovery-native-proof.mjs'] : []), ...(phaseCapture ? ['apps/desktop/scripts/prompt-preparation-stage-native-proof.mjs', 'apps/desktop/scripts/fixtures/prompt-preparation-stage'] : []), ...(demandCollaboration ? ['apps/desktop/scripts/demand-collaboration-restart-proof.mjs', 'apps/desktop/scripts/verify-demand-collaboration-e2e.mjs'] : [])]) {
        await cp(join(root, path), join(privateRoot, path), { recursive: true });
        if (demandCollaboration) build.proofOverlays[path] = sha(await readFile(join(privateRoot, path)))
      }
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
    const directories = ['apps/desktop/src', 'apps/desktop/browser-extension', 'apps/desktop/scripts', 'apps/desktop/brand', 'apps/host/native', 'apps/desktop/resources', 'apps/host/src', 'apps/host/scripts',
      'packages/core/src', 'packages/core/scripts', 'packages/core/guides', 'packages/core/bin', 'packages/core/vendor',
      'packages/demand/src', 'packages/demand/bin', 'packages/relay/src', 'packages/client-ui/src', 'packages/client-ui/scripts', 'packages/layout/src', 'patches', ...(demandCollaboration || inactiveWindow ? ['packages/git/src', 'packages/identity/src'] : []),
      ...(demandCollaboration ? ['packages/core/test/fixtures'] : []), ...(inactiveWindow ? ['packages/core/native', 'packages/diagnostic-evidence/src', 'packages/connectors/src', 'apps/desktop/vendor/drawio/v32.4.1'] : []),
      ...(displayLayoutSet ? ['packages/identity/scripts', 'packages/capsule/src'] : [])]
    for (const directory of directories) {
      if (!requestedSourceRef) {
        try { await cp(join(root, directory), join(privateRoot, directory), { recursive: true }) }
        catch (error) { if (!(directory === 'apps/desktop/brand' && error.code === 'ENOENT')) throw error }
      }
      try { await record(join(privateRoot, directory), build.sources) }
      catch (error) { if (!(directory === 'apps/desktop/brand' && error.code === 'ENOENT')) throw error }
    }
    for (const path of ['package.json', 'tsconfig.base.json', 'tsconfig.shared.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'apps/desktop/package.json', 'apps/desktop/electron.vite.config.ts',
      'apps/host/package.json', ...(displayLayoutSet ? ['apps/host/tsconfig.json'] : []), ...(inactiveWindow ? ['test/fixture-values.mjs'] : []), ...packages.flatMap(pkg => ['package.json', 'tsconfig.json', 'tsconfig.build.json'].map(name => 'packages/' + pkg + '/' + name))]) {
      try { const bytes = await readFile(join(requestedSourceRef ? privateRoot : root, path)); await mkdir(dirname(join(privateRoot, path)), { recursive: true }); await writeFile(join(privateRoot, path), bytes); build.sources[path] = sha(bytes) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    // Shadow only workspace dependencies. Ordinary installed packages are read-only shared inputs;
    // Desktop Main and every private Core consumer resolve the compiled private Core, never stale dist.
    if (demandCollaboration) {
      const yaml = require(require.resolve('yaml', { paths: [join(root, 'packages/core')] }))
      const lock = yaml.parse(await readFile(join(privateRoot, 'pnpm-lock.yaml'), 'utf8'))
      const dependencyRoot = dirname(await realpath(join(root, 'node_modules')))
      const poolDirectory = await realpath(join(root, 'node_modules/.pnpm'))
      const pool = await readdir(poolDirectory)
      build.exactDependencies = []
      for (const consumer of ['.', 'apps/desktop', ...packages.map(name => 'packages/' + name)]) {
        const manifest = JSON.parse(await readFile(join(privateRoot, consumer, 'package.json')))
        const modules = join(privateRoot, consumer, 'node_modules')
        await mkdir(join(modules, '@agentmux'), { recursive: true })
        for (const name of packages) await symlink(join(privateRoot, 'packages', name), join(modules, '@agentmux', name))
        for (const section of ['dependencies', 'devDependencies']) for (const [name, specification] of Object.entries(manifest[section] ?? {})) {
          if (specification.startsWith('workspace:') || name === '@ctxmux/sdk') continue
          const locked = lock.importers?.[consumer]?.[section]?.[name]?.version
          assert.equal(typeof locked, 'string', 'Exact lock owner: ' + consumer + ':' + name)
          const version = locked.split('(')[0], prefix = name.replace('/', '+') + '@' + version
          const candidates = pool.filter(entry => entry === prefix || entry.startsWith(prefix + '_'))
          let installed
          if (candidates.length === 1) installed = join(poolDirectory, candidates[0], 'node_modules', name)
          else {
            installed = await realpath(join(dependencyRoot, consumer, 'node_modules', name)).catch(() => undefined)
            assert.ok(installed && candidates.some(entry => installed === join(poolDirectory, entry, 'node_modules', name)), 'One original installed lock/peer resolution: ' + consumer + ':' + name)
          }
          const bytes = await readFile(join(installed, 'package.json'))
          assert.equal(JSON.parse(bytes).version, version)
          await mkdir(dirname(join(modules, name)), { recursive: true }); await symlink(installed, join(modules, name))
          build.exactDependencies.push({ consumer, name, specification, locked, installed, packageSha256: sha(bytes) })
        }
      }
    } else {
    for (const directory of ['node_modules', 'apps/desktop/node_modules', ...(displayLayoutSet ? ['apps/host/node_modules'] : []), ...packages.map(pkg => 'packages/' + pkg + '/node_modules')]) {
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
      if (displayLayoutSet) await symlink(join(privateRoot, 'apps/host'), join(privateRoot, directory, '@agentmux/host'), 'dir')
    }
    }
    if (demandCollaboration) {
      const toolRequire = createRequire(join(privateRoot, 'packages/core/package.json'))
      build.privateBuildTools = {}
      for (const [name, bin, path] of [['typescript', 'tsc', 'bin/tsc'], ['esbuild', 'esbuild', 'bin/esbuild']]) {
        const packagePath = toolRequire.resolve(name + '/package.json'), packageBytes = await readFile(packagePath)
        const executable = join(dirname(packagePath), path)
        for (const directory of ['node_modules', 'packages/core/node_modules']) { await mkdir(join(privateRoot, directory, '.bin'), { recursive: true }); await symlink(executable, join(privateRoot, directory, '.bin', bin)) }
        build.privateBuildTools[name] = { executable, packageSha256: sha(packageBytes), executableSha256: sha(await readFile(executable)) }
      }
    }
    if (steerRecovery || phaseCapture || demandCollaboration || displayLayoutSet) {
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
    if (demandCollaboration || inactiveWindow) for (const [pkg, config] of [['identity', 'tsconfig.json'], ['git', 'tsconfig.build.json'], ...(inactiveWindow ? [['diagnostic-evidence', 'tsconfig.json']] : [])]) {
      await command('private-' + pkg + '-build', process.execPath, displayLayoutSet && pkg === 'identity'
        ? [join(privateRoot, 'packages/identity/scripts/build.mjs')]
        : [require.resolve('typescript/bin/tsc'), '-p', 'packages/' + pkg + '/' + config], privateRoot)
      await record(join(privateRoot, 'packages', pkg, 'dist'), build.compiled)
    }
    if (displayLayoutSet) {
      await command('private-capsule-build', process.execPath, [require.resolve('typescript/bin/tsc'), '-b', 'packages/capsule/tsconfig.build.json', '--force'], privateRoot)
      await record(join(privateRoot, 'packages/capsule/dist'), build.compiled)
    }
    await command('private-demand-build', process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'packages/demand/tsconfig.build.json'], privateRoot)
    await command('private-relay-build', process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'packages/relay/tsconfig.json'], privateRoot)
    await command('private-core-build', process.execPath, [join(privateRoot, 'packages/core/scripts/build.mjs')], privateRoot)
    if (demandCollaboration || inactiveWindow) { await command('private-client-ui-build', process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'packages/client-ui/tsconfig.build.json'], privateRoot); await record(join(privateRoot, 'packages/client-ui/dist'), build.compiled) }
    if (inactiveWindow) { await command('private-connectors-build', process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'packages/connectors/tsconfig.json'], privateRoot); await record(join(privateRoot, 'packages/connectors/dist'), build.compiled) }
    if (displayLayoutSet) { await command('private-host-build', process.execPath, [join(privateRoot, 'apps/host/scripts/build.mjs')], privateRoot); await record(join(privateRoot, 'apps/host/dist'), build.compiled) }
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
    if (demandCollaboration) {
      build.newWorkspaceConsumers = {}
      for (const directory of ['packages/core/node_modules', 'apps/desktop/node_modules']) {
        const path = join(privateRoot, directory, 'demand-collaboration-consumer.mjs')
        await writeFile(path, "import{fileURLToPath}from'node:url';await import('@agentmux/git');await import('@agentmux/identity');console.log(JSON.stringify(Object.fromEntries(['@agentmux/git','@agentmux/git/types','@agentmux/identity','@agentmux/core'].map(name=>[name,fileURLToPath(import.meta.resolve(name))]))));\n")
        const loaded = JSON.parse((await exec(process.execPath, [path], { cwd: privateRoot })).stdout); await rm(path)
        build.newWorkspaceConsumers[directory] = {}
        for (const [name, entry] of Object.entries(loaded)) {
          assert.ok(entry.startsWith(join(privateRoot, 'packages')), 'Exact private workspace consumer: ' + name)
          build.newWorkspaceConsumers[directory][name] = { entry: relative(privateRoot, entry), sha256: sha(await readFile(entry)) }
        }
      }
    }
    const brandScript = join(privateRoot, 'apps/desktop/scripts/build-brand-assets.mjs')
    try { await readFile(brandScript); await command('private-brand-build', process.execPath, [brandScript], privateRoot) }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      build.brandInputs = { reason: 'This exact committed source has no brand derivation script; its tracked consumer bitmaps are used unchanged.' }
    }
    await command('private-workspace-helper-build', process.execPath, [join(privateRoot, 'apps/desktop/scripts/build-workspace-move-helper.mjs')], privateRoot)
    if (demandCollaboration) build.workspaceHelper = { sourceSha256: build.sources['apps/host/native/workspace-move.c'], builderSha256: build.sources['apps/desktop/scripts/build-workspace-move-helper.mjs'], binarySha256: sha(await readFile(join(privateRoot, 'apps/desktop/resources/bin/agentmux-workspace-move'))) }
    const closurePath = join(evidence, 'desktop-source-closure.json')
    const inactiveCompilerReceipt = join(evidence, 'inactive-window-compiler-input.json')
    const config = join(privateRoot, 'apps/desktop/restart-proof.vite.config.mjs')
    let inactiveInput = null
    if (inactiveWindow) {
      const owner = 'apps/desktop/src/main/index.ts', original = await readFile(join(privateRoot, owner), 'utf8')
      const constructor = 'const window = new BrowserWindow({\n      ...windowConstructorGeometry(persistedGeometry),'
      const placement = '    workbenchWindow = window'
      assert.equal(original.split(constructor).length - 1, 1, 'One exact private workbench window constructor')
      assert.equal(original.split(placement).length - 1, 1, 'One exact private workbench window owner')
      const presentation = `    window.show = () => window.showInactive()
    window.focus = () => {}
    let privateWindowFocusedEver = window.isFocused()
    const recordPrivateWindow = async () => writeFile(${JSON.stringify(inactiveWindowDirectory)} + '/window-' + process.pid + '.json', JSON.stringify({
      pid: process.pid, id: window.id, focused: window.isFocused(), focusedEver: privateWindowFocusedEver,
      home: process.env.HOME, nodeHome: (await import('node:os')).homedir(),
      focusable: window.isFocusable(), visible: window.isVisible(), kind: 'test-only-nonactivating-workbench'
    }))
    window.on('focus', () => { privateWindowFocusedEver = true; void recordPrivateWindow() })
    window.webContents.on('did-finish-load', () => { void recordPrivateWindow() })
    window.showInactive()
    await recordPrivateWindow()
`
      const source = original.replace(constructor, constructor + '\n      show: false, focusable: false,')
        .replace(placement, presentation + placement)
      inactiveInput = { owner: join(privateRoot, owner), source }
      build.privateWindowOverlay = { owner, originalSHA256: sha(original), compilerInputSHA256: sha(source),
        observationDirectory: inactiveWindowDirectory, sharedSourceWritten: false,
        scope: 'Only private BrowserWindow presentation: construct hidden/nonfocusable, showInactive, ignore OS-focus requests. Original Core/Renderer/recovery code remains unchanged.' }
    }
    await writeFile(config, `import actual from './electron.vite.config.ts';import{readFile,writeFile}from'node:fs/promises';import{createHash}from'node:crypto';import{relative}from'node:path';
const root=${JSON.stringify(privateRoot)},loaded={},inactiveInput=${JSON.stringify(inactiveInput)};
const plugin=()=>({name:'private-restart-source-identity',enforce:'pre',async load(id){if(id.startsWith(root+'/')&&!id.includes('/node_modules/')&&!id.includes('?')){try{loaded[relative(root,id)]=createHash('sha256').update(await readFile(id)).digest('hex')}catch{}}if(inactiveInput&&id===inactiveInput.owner){await writeFile(${JSON.stringify(inactiveCompilerReceipt)},JSON.stringify({owner:relative(root,id),originalSHA256:loaded[relative(root,id)],compilerInputSHA256:createHash('sha256').update(inactiveInput.source).digest('hex')}));return inactiveInput.source}},async closeBundle(){await writeFile(${JSON.stringify(closurePath)},JSON.stringify(loaded,null,2))}});
export default Object.fromEntries(Object.entries(actual).map(([key,value])=>[key,{...value,plugins:[plugin(),...(value.plugins??[])]}]));\n`)
    await command('private-desktop-build', process.execPath, [join(root, 'apps/desktop/node_modules/electron-vite/bin/electron-vite.js'), 'build', '--config', config], join(privateRoot, 'apps/desktop'))
    if (inactiveWindow) {
      const applied = JSON.parse(await readFile(inactiveCompilerReceipt, 'utf8'))
      assert.equal(applied.owner, build.privateWindowOverlay.owner)
      assert.equal(applied.originalSHA256, build.privateWindowOverlay.originalSHA256)
      assert.equal(applied.compilerInputSHA256, build.privateWindowOverlay.compilerInputSHA256)
      build.privateWindowOverlay.appliedCompilerReceipt = inactiveCompilerReceipt
    }
    build.desktopSourceClosure = JSON.parse(await readFile(closurePath, 'utf8'))
    for (const path of ['apps/desktop/src/main/index.ts', 'apps/desktop/src/preload/index.ts', 'apps/desktop/src/shared/contracts.ts', 'apps/desktop/src/renderer/src/lib/api.ts',
      'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx', 'apps/desktop/src/renderer/src/components/SessionMailbox.tsx']) {
      assert.equal(build.desktopSourceClosure[path], build.sources[path], 'Private Desktop consumed actual captured production source: ' + path)
    }
    if (displayLayoutSet) for (const path of ['apps/desktop/src/renderer/src/lib/workbench-persistence.ts', 'apps/desktop/src/renderer/src/lib/desktop-spatial-state.ts']) {
      assert.equal(build.desktopSourceClosure[path], build.sources[path], 'Actual layout restore and persistence owner: ' + path)
    }
    if (demandCollaboration) for (const path of ['apps/host/src/goal-dispatch-input.ts', 'apps/desktop/src/shared/goal-pmo-origin.ts', 'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/renderer/src/components/RegionCurrentDemand.tsx', 'apps/desktop/src/renderer/src/components/GoalContinuationControl.tsx', 'apps/desktop/src/renderer/src/components/settings/GoalsSettingsPane.tsx', 'apps/desktop/src/renderer/src/components/GoalAgentPicker.tsx', 'apps/desktop/src/renderer/src/lib/primary-mote-executor.ts', 'apps/desktop/src/renderer/src/lib/goal-current-work.ts']) {
      assert.equal(build.desktopSourceClosure[path], build.sources[path], 'Actual new collaboration consumer: ' + path)
    }
    if (displayLayoutSet) await command('private-renderer-release', process.execPath, [join(privateRoot, 'apps/desktop/scripts/build-renderer-release.mjs')], privateRoot)
    await record(join(privateRoot, 'apps/desktop/out'), build.compiled)
    await record(join(privateRoot, 'packages/core/dist'), build.compiled)
    assert.ok(Object.keys(build.compiled).length > 100)
    if (displayLayoutSet) {
      const html = await readFile(join(privateRoot, 'apps/desktop/out/renderer/index.html'), 'utf8')
      const entry = /<script[^>]*\bsrc="\.\/([^"<>]+)"/.exec(html)?.[1]
      assert.ok(entry && !entry.includes('..'), 'Preserve the actual Renderer entry identity')
      build.preservedCompiled = {}
      for (const path of ['main/index.js', 'preload/index.cjs', 'renderer/index.html', 'renderer/release.json', 'renderer/' + entry]) {
        const source = 'apps/desktop/out/' + path, destination = join(evidence, 'compiled', path)
        await mkdir(dirname(destination), { recursive: true }); await cp(join(privateRoot, source), destination)
        const copied = sha(await readFile(destination)); assert.equal(copied, build.compiled[source])
        build.preservedCompiled[source] = { path: destination, sha256: copied }
      }
    }
    await mkdir(privateHome, { recursive: true, mode: 0o700 })
    build.privateHome = { path: privateHome, source: 'test-process-env', parentEnvironmentMutated: false,
      scope: 'Set before loading the entire worker; Core/Provider setup and all private Electron descendants inherit this HOME.' }
    await writeFile(buildReceiptPath, JSON.stringify(build, null, 2))
    const args = arguments_.filter(value => value !== '--inactive-window' && !value.startsWith('--receipt-path=') && !value.startsWith('--probe-root=') && !value.startsWith('--' + mode + '-source-ref=') && !value.startsWith('--startup-first-send-product-manifest=') && !value.startsWith('--startup-first-send-product-manifest-sha='))
    const lines = []
    const executionEnvironment = { ...process.env, HOME: privateHome, [environmentKey]: buildReceiptPath }
    delete executionEnvironment.ELECTRON_RUN_AS_NODE
    outcome = await runProbeProcess(process.execPath, [join(privateRoot, 'apps/desktop/scripts', worker), ...args,
      '--probe-root=' + privateRoot, '--receipt-path=' + receiptPath], { cwd: privateRoot, temporaryRoot: privateRoot,
      env: executionEnvironment, timeoutMs: demandCollaboration ? 600_000 : steerRecovery || phaseCapture ? 300_000 : 130_000, onLine: line => lines.push(line) })
    await writeFile(join(evidence, 'restart.log'), lines.join('\n') + '\n')
    assert.equal(outcome.timedOut, false)
    assert.equal(outcome.exitCode, 0)
    const result = JSON.parse(await readFile(receiptPath, 'utf8'))
    assert.equal(result.passed, true); assert.equal(result[resultField]?.passed, true)
    if (mode === 'pending-edit' || displayLayoutSet) {
      const observed = JSON.parse(await readFile(join(evidence, 'worker-home.json'), 'utf8'))
      assert.equal(observed.pid, outcome.originalPid)
      assert.equal(observed.privateRoot, privateRoot); assert.equal(observed.sourceCommit, sourceCommit)
      assert.equal(observed.home, privateHome); assert.equal(observed.nodeHome, privateHome)
      assert.equal(observed.beforeCoreImports, true)
      assert.equal(observed.workerSHA256, build.sources['apps/desktop/scripts/' + worker])
      build.privateHome.startupObservation = observed
    }
    if (inactiveWindow) {
      const files = (await readdir(inactiveWindowDirectory)).filter(file => file.startsWith('window-') && file.endsWith('.json'))
      assert.ok(files.length >= 3, 'Seed plus two real App processes report private window identity')
      build.privateWindowObservations = await Promise.all(files.map(async file => JSON.parse(await readFile(join(inactiveWindowDirectory, file), 'utf8'))))
      assert.ok(build.privateWindowObservations.every(window => window.focusable === false && window.focusedEver === false && window.visible === true),
        'Every actual private App window stays visible without taking OS focus')
      assert.ok(build.privateWindowObservations.every(window => window.home === privateHome && window.nodeHome === privateHome),
        'Every actual private App resolves HOME and homedir() inside this proof root')
      build.privateHome.appConnectorDirectories = build.privateWindowObservations.map(window => ({
        pid: window.pid, path: join(window.nodeHome, '.agentmux', 'connectors'),
        basis: 'Observed post-hydration Main homedir plus exact ipc.ts connector owner',
        ownerSourceSHA256: build.sources['apps/desktop/src/main/ipc.ts']
      }))
      const databasePath = join(privateHome, '.agentmux', 'connectors', 'connections.sqlite')
      try {
        const metadata = await stat(databasePath)
        build.privateHome.connectorDatabase = { path: databasePath, isFile: metadata.isFile(), size: metadata.size }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        build.privateHome.connectorDatabase = { path: databasePath, exists: false }
      }
    }
  } catch (error) { failure = error; outcome ??= error.probe }
  finally {
    const differenceField = requestedSourceRef ? 'capturedSourceVsSharedWorkingAtCompletion' : 'sharedSourceChangesDuringProof'
    build[differenceField] = []
    for (const [path, captured] of Object.entries(build.sources)) {
      let current
      try { current = sha(await readFile(join(root, path))) } catch (error) { if (error.code !== 'ENOENT') throw error; current = null }
      if (current !== captured) build[differenceField].push({ path, captured, current })
    }
    const remaining = await listProbeProcesses(-1, privateRoot)
    if (displayLayoutSet && remaining.length) {
      build.cleanup = { privateRootRetained: true, remaining }
      failure ??= new Error('Private restart leaves owned processes; retain its build and fixture tree')
    } else {
      assert.deepEqual(remaining, [], 'Private restart leaves no processes in its build or fixture tree')
      await rm(privateRoot, { recursive: true, force: true }); build.privateRootRemoved = true
    }
    // A failed extraction can leave the reproducible committed archive; it contains no Run or
    // unsaved data. Keep its exact sourceCommit and failure receipt, not a redundant cache.
    await rm(sourceArchivePath, { force: true })
    await writeFile(buildReceiptPath, JSON.stringify(build, null, 2))
    await writeFile(join(evidence, 'summary.json'), JSON.stringify({ schema: demandCollaboration ? 'agentmux.demand-collaboration-native-build.v1' : phaseCapture ? 'agentmux.prompt-preparation-stage-build-proof.v1' : steerRecovery ? 'agentmux.steer-recovery-restart-proof.v1' : 'agentmux.pending-edit-restart-proof.v1', passed: !failure,
      receiptPath, buildReceiptPath, outcome, qualifiedScope: demandCollaboration ? 'complete-private-Electron-two-PID-NewGoal-default-source-dispatch-workface-recovery' : phaseCapture ? 'actual-Electron-IPC-and-limited-phase-visual-only' : finalQualification ? 'Fresh-complete-Main-GUI-A-B-C-only' : startupRestoredOnly ? 'GUI-restored-first-Send-only' : startupFirstSend ? 'Native-initial-and-GUI-restored-first-Send-only' : typedFirstHook ? 'SDK-two-Core-first-Hook-Native-only' : typedCrossCore ? 'SDK-two-Core-Native-only' : diagnosticOnly ? 'first-Send-diagnostic-only' : mode, userRunTouched: false, sharedSourceWritten: false,
      failure: failure ? { name: failure.name, message: failure.message, stack: failure.stack } : null }, null, 2))
  }
  process.stdout.write(JSON.stringify({ mode: '--' + mode, passed: !failure, receiptPath, buildReceiptPath, evidence,
    failure: steerRecovery ? failure?.message.split('\n')[0] : failure?.message }) + '\n')
  return failure ? 1 : 0
}
