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
const packages = ['core', 'demand', 'client-ui', 'layout']

/** A new restart mode reuses the real harness; only its build tree is private. */
export async function runPendingEditRestart(arguments_) {
  const evidence = join(root, '.tmp/composer-pending-edit-restart', String(globalThis.crypto.randomUUID()))
  // The inner real harness has Unix sockets below this tree. macOS's per-user
  // tmpdir prefix would exceed sockaddr_un's path limit after that nesting.
  const privateRoot = await realpath(await mkdtemp(join(process.platform === 'darwin' ? _hygiene_fixturePath("tmp") : tmpdir(), 'amx-pe-')))
  await mkdir(evidence, { recursive: true })
  const requestedReceipt = arguments_.find(value => value.startsWith('--receipt-path='))?.slice('--receipt-path='.length)
  const receiptPath = requestedReceipt ? resolve(root, requestedReceipt) : join(evidence, 'receipt.json')
  const buildReceiptPath = join(evidence, 'build.json')
  const requestedSourceRef = arguments_.find(value => value.startsWith('--pending-edit-source-ref='))?.slice('--pending-edit-source-ref='.length)
  const sourceCommit = (await exec('git', ['rev-parse', '--verify', '--end-of-options', (requestedSourceRef ?? 'HEAD') + '^{commit}'], { cwd: root })).stdout.trim()
  const build = { schema: 'agentmux.pending-edit-restart-build.v1', privateRoot, sources: {}, compiled: {},
    sharedSourceWritten: false, userRunTouched: false, sourceCommit,
    sourceMode: requestedSourceRef ? 'exact-git-archive-with-test-only-overlay' : 'captured-working-source', requestedSourceRef: requestedSourceRef ?? null }
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
      const archive = join(evidence, 'source.tar')
      await exec('git', ['archive', '--format=tar', '--output=' + archive, sourceCommit], { cwd: root })
      await exec('tar', ['-xf', archive, '-C', privateRoot])
      await rm(archive)
      // Overlay only the two owning proof scripts from this execution tree;
      // all product code comes from the exact committed source.
      for (const path of ['apps/desktop/scripts/verify-workbench-persistence-restart.mjs', 'apps/desktop/scripts/pending-edit-restart-proof.mjs'])
        await cp(join(root, path), join(privateRoot, path))
    }
    const directories = ['apps/desktop/src', 'apps/desktop/browser-extension', 'apps/desktop/scripts', 'apps/desktop/brand', 'apps/desktop/native', 'apps/desktop/resources', 'apps/host/src',
      'packages/core/src', 'packages/core/scripts', 'packages/core/bin', 'packages/core/vendor',
      'packages/demand/src', 'packages/demand/bin', 'packages/client-ui/src', 'packages/layout/src', 'patches']
    for (const directory of directories) {
      if (!requestedSourceRef) await cp(join(root, directory), join(privateRoot, directory), { recursive: true })
      try { await record(join(privateRoot, directory), build.sources) }
      catch (error) { if (!(requestedSourceRef && directory === 'apps/desktop/brand' && error.code === 'ENOENT')) throw error }
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
        if (entry.startsWith('@')) {
          await mkdir(join(privateRoot, directory, entry), { recursive: true })
          for (const pkg of await readdir(join(root, directory, entry))) {
            await symlink(join(root, directory, entry, pkg), join(privateRoot, directory, entry, pkg))
          }
        } else await symlink(join(root, directory, entry), join(privateRoot, directory, entry))
      }
      for (const pkg of packages) await symlink(join(privateRoot, 'packages', pkg), join(privateRoot, directory, '@agentmux', pkg), 'dir')
    }
    // Resolve the declared ws dependency from the installed pool when a copied
    // workspace has no direct link. This fixture never installs dependencies;
    // the receipt records both the declared version and consumed package.
    try { require.resolve('ws', { paths: [join(privateRoot, 'apps/desktop')] }) }
    catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error
      const installed = (await readdir(join(root, 'node_modules/.pnpm'))).filter(name => /^ws@/.test(name))
      assert.equal(installed.length, 1, 'Private fixture requires an unambiguous installed ws version')
      const path = join(root, 'node_modules/.pnpm', installed[0], 'node_modules/ws')
      await symlink(path, join(privateRoot, 'apps/desktop/node_modules/ws'), 'dir')
      build.fixtureInstalledDependency = { name: 'ws', path, packageSha256: sha(await readFile(join(path, 'package.json'))),
        declaredVersion: JSON.parse(await readFile(join(privateRoot, 'apps/desktop/package.json'), 'utf8')).dependencies?.ws ?? null,
        reason: 'Private copied build resolves the one already installed ws package directly; no install or shared dependency edit.' }
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
    await command('private-core-build', process.execPath, [join(privateRoot, 'packages/core/scripts/build.mjs')], privateRoot)
    const brandScript = join(privateRoot, 'apps/desktop/scripts/build-brand-assets.mjs')
    try { await readFile(brandScript); await command('private-brand-build', process.execPath, [brandScript], privateRoot) }
    catch (error) {
      if (!(requestedSourceRef && error.code === 'ENOENT')) throw error
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
    const args = arguments_.filter(value => !value.startsWith('--receipt-path=') && !value.startsWith('--probe-root=') && !value.startsWith('--pending-edit-source-ref='))
    const lines = []
    const executionEnvironment = { ...process.env, AGENTMUX_PENDING_EDIT_BUILD_RECEIPT: buildReceiptPath }
    delete executionEnvironment.ELECTRON_RUN_AS_NODE
    outcome = await runProbeProcess(process.execPath, [join(privateRoot, 'apps/desktop/scripts/verify-workbench-persistence-restart.mjs'), ...args,
      '--probe-root=' + privateRoot, '--receipt-path=' + receiptPath], { cwd: privateRoot, temporaryRoot: privateRoot,
      env: executionEnvironment, timeoutMs: 130_000, onLine: line => lines.push(line) })
    await writeFile(join(evidence, 'restart.log'), lines.join('\n') + '\n')
    assert.equal(outcome.timedOut, false)
    assert.equal(outcome.exitCode, 0)
    const result = JSON.parse(await readFile(receiptPath, 'utf8'))
    assert.equal(result.passed, true); assert.equal(result.pendingEdit?.passed, true)
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
    await writeFile(buildReceiptPath, JSON.stringify(build, null, 2))
    await writeFile(join(evidence, 'summary.json'), JSON.stringify({ schema: 'agentmux.pending-edit-restart-proof.v1', passed: !failure,
      receiptPath, buildReceiptPath, outcome, userRunTouched: false, sharedSourceWritten: false,
      failure: failure ? { name: failure.name, message: failure.message, stack: failure.stack } : null }, null, 2))
  }
  process.stdout.write(JSON.stringify({ mode: '--pending-edit', passed: !failure, receiptPath, buildReceiptPath, evidence, failure: failure?.message }) + '\n')
  return failure ? 1 : 0
}
