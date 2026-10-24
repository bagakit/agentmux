import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { resolvePackageRoot } from '../../../scripts/package-dependencies.mjs'

assert.ok(process.argv.slice(2).every(arg => arg === '--mutations'))
assert.equal(process.platform + '-' + process.arch, 'darwin-arm64', 'The original macOS entry has this exact platform contract.')
const root = resolve(import.meta.dirname, '../../..'), product = 'apps/desktop/scripts/package-macos.mjs'
const evidence = resolve(process.env.AGENTMUX_PACKAGE_BOOTSTRAP_EVIDENCE ?? join(root, '.local/state/package-bootstrap', randomUUID()))
await mkdir(evidence, { recursive: true })
const digest = bytes => createHash('sha256').update(bytes).digest('hex'), inputs = new Map()
async function source(path) {
  const bytes = await readFile(join(root, path)), sha = digest(bytes)
  if (inputs.has(path)) assert.equal(inputs.get(path), sha, 'An observed source changed during qualification.')
  inputs.set(path, sha); return bytes.toString('utf8')
}
async function child(command, args, options = {}) {
  return await new Promise((yes, no) => {
    const process = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; process.stdout.on('data', bytes => { output += bytes }); process.stderr.on('data', bytes => { output += bytes })
    process.once('error', no); process.once('close', (exit, signal) => yes({ exit, signal, output }))
  })
}
const original = await source(product), desktopManifest = JSON.parse(await source('apps/desktop/package.json'))
const rootManifest = JSON.parse(await source('package.json'))
assert.equal(rootManifest.scripts['package:mac:install'], 'pnpm --filter @agentmux/desktop package:mac:install')
assert.equal(desktopManifest.scripts['package:mac:install'], 'node scripts/package-macos.mjs --install')
// Parse only the real static module graph. Workspace exports remain absent in the fixture.
const graph = new Map(), pending = [product, 'apps/desktop/scripts/package-runtime-upgrade.mjs', 'apps/desktop/scripts/package-semantic-host.mjs']
while (pending.length) {
  const path = pending.shift()
  if (graph.has(path)) continue
  const text = await source(path); graph.set(path, text)
  const ast = ts.createSourceFile(path, text, ts.ScriptTarget.ESNext, true, path.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS)
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const name = statement.moduleSpecifier.text
    if (!name.startsWith('.') || name.includes('/dist/')) continue
    const target = relative(root, resolve(root, dirname(path), name))
    let found
    for (const file of [target, target.replace(/\.js$/u, '.ts')]) {
      try { await readFile(join(root, file)); found = file; break } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    assert.ok(found, 'The exact static source dependency exists: ' + target); pending.push(found)
  }
}
assert.ok(graph.size > 10, 'A nonempty actual entry graph is copied, not a replacement packaging implementation.')
const pnpm = (await child('which', ['pnpm'], { cwd: root, env: process.env })).output.trim()
assert.ok(pnpm.startsWith('/'))
const prebuild = desktopManifest.scripts.prebuild
const clauses = prebuild.split(' && ').map(command => command.split(/\s+/u))
assert.ok(clauses.length >= 7 && clauses.every(command => command[0] === 'pnpm'), 'Consume the original complete Desktop prebuild.')
const expectedStages = clauses.map(command => command.slice(1))
const ownerImports = {
  'eager-runtime': "import { observeUiClient } from './package-runtime-upgrade.mjs'",
  'eager-semantic': "import { prepareSemanticHostReload } from './package-semantic-host.mjs'",
  'eager-core': "import { probeSocketLiveness } from '@agentmux/core'",
  'eager-host': "import { macosHostService } from '../../host/dist/macos-service.js'"
}
const buildAnchor = "  await run('pnpm', ['--config.enable-pre-post-scripts=true', 'build'], { cwd: desktopRoot })"
assert.equal(original.split(buildAnchor).length, 2)
const variants = [{ name: 'candidate', text: original }, ...(process.argv.includes('--mutations') ? [
  ...Object.entries(ownerImports).map(([name, line]) => ({ name, text: line + '\n' + original })),
  { name: 'duplicate-dependency-build', text: original.replace(buildAnchor, "  await run('pnpm', ['--filter', '@agentmux/client-ui...', 'build'], { cwd: repositoryRoot })\n" + buildAnchor) },
  { name: 'disabled-prebuild', text: original.replace(buildAnchor, "  await run('pnpm', ['build'], { cwd: desktopRoot })") },
  { name: 'restored', text: original }
] : [])]
const receipt = { passed: false, userAppOrRunTouched: false, source: null, cases: [],
  scope: 'Actual Node package entry in a clean private source graph with Core/Host dist absent, stopping at the build boundary; captured real argv consumed by actual pnpm11 and the original prebuild script, with print-only subprocesses. No real package build, App copy, signing, installation or Runtime operation. Existing installer consumers use this tree Source.' }
async function fixture(text) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'amx-package-bootstrap-'))), project = join(directory, 'checkout'), log = join(directory, 'entry-build.jsonl')
  await mkdir(project)
  for (const [path, bytes] of graph) { await mkdir(dirname(join(project, path)), { recursive: true }); await writeFile(join(project, path), path === product ? text : bytes) }
  for (const path of ['package.json', 'apps/desktop/package.json', 'packages/core/package.json']) {
    await mkdir(dirname(join(project, path)), { recursive: true }); await writeFile(join(project, path), await source(path))
  }
  await writeFile(join(project, '.gitignore'), 'node_modules/\n')
  const modules = join(project, 'apps/desktop/node_modules')
  await mkdir(join(modules, '@agentmux'), { recursive: true }); await symlink(join(project, 'packages/core'), join(modules, '@agentmux/core'))
  for (const name of ['@electron/osx-sign', 'zod']) {
    const destination = join(modules, name); await mkdir(dirname(destination), { recursive: true })
    await symlink(await resolvePackageRoot(join(root, 'apps/desktop'), name, root), destination)
  }
  // Electron is only an empty private installer fixture. The real entry stops before copying any App.
  const electron = join(modules, 'electron'); await mkdir(join(electron, 'dist/Electron.app'), { recursive: true })
  await writeFile(join(electron, 'package.json'), '{"name":"electron","version":"0.0.0-private-bootstrap-fixture"}\n')
  await writeFile(join(electron, 'install.js'), "process.stdout.write('private_electron_fixture_only\\n')\n")
  const bin = join(directory, 'bin'); await mkdir(bin)
  await writeFile(join(bin, 'pnpm'), '#!' + process.execPath + '\n' +
    "const fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(" + JSON.stringify(log) + ",JSON.stringify(args)+'\\n');process.exit(args.includes('--filter')?0:75)\n", { mode: 0o700 })
  const env = { PATH: bin + ':' + dirname(process.execPath) + ':/usr/bin:/bin', HOME: join(directory, 'home'), TMPDIR: directory }
  await mkdir(env.HOME)
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Private Bootstrap Fixture', '-c', 'user.email=fixture@invalid', 'commit', '-qm', 'Private source graph']]) {
    const git = await child('git', args, { cwd: project, env }); assert.equal(git.exit, 0, git.output)
  }
  return { directory, project, log, env }
}
async function lifecycle(directory, argv) {
  const cwd = join(directory, 'lifecycle'), bin = join(directory, 'lifecycle-bin'), log = join(directory, 'lifecycle.jsonl'), done = join(directory, 'lifecycle-complete')
  await mkdir(cwd); await mkdir(bin)
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: 'private-bootstrap-lifecycle', private: true, packageManager: rootManifest.packageManager,
    scripts: { prebuild, build: 'node ' + JSON.stringify(join(cwd, 'complete.cjs')) } }))
  await writeFile(join(cwd, 'complete.cjs'), "require('node:fs').writeFileSync(" + JSON.stringify(done) + ",'complete')\n")
  await writeFile(join(bin, 'pnpm'), '#!' + process.execPath + '\n' + "require('node:fs').appendFileSync(" + JSON.stringify(log) + ",JSON.stringify(process.argv.slice(2))+'\\n')\n", { mode: 0o700 })
  // Reuse only the installed package-manager cache; nested build commands are private print-only stubs.
  const env = { PATH: bin + ':' + dirname(process.execPath) + ':/usr/bin:/bin', HOME: process.env.HOME, pnpm_config_enable_pre_post_scripts: 'false', COREPACK_ENABLE_NETWORK: '0' }
  const run = await child(pnpm, argv, { cwd, env })
  const stages = (await readFile(log, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })).trim().split('\n').filter(Boolean).map(JSON.parse)
  const complete = await readFile(done, 'utf8').then(value => value === 'complete', () => false)
  return { exit: run.exit, output: run.output, stages, complete, passed: run.exit === 0 && complete && JSON.stringify(stages) === JSON.stringify(expectedStages) }
}
try {
  for (const variant of variants) {
    const own = await fixture(variant.text)
    try {
      const absent = ['packages/core/dist', 'apps/host/dist']
      for (const path of absent) await assert.rejects(readFile(join(own.project, path)), { code: 'ENOENT' })
      const run = await child(process.execPath, [join(own.project, product), '--app-only', '--ad-hoc'], { cwd: join(own.project, 'apps/desktop'), env: own.env })
      const calls = (await readFile(own.log, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })).trim().split('\n').filter(Boolean).map(JSON.parse)
      let actualLifecycle = null
      if (calls.length === 1) actualLifecycle = await lifecycle(own.directory, calls[0])
      const reached = run.exit === 1 && run.signal === null && calls.length === 1 && run.output.includes('pnpm exited with 75')
      const passed = reached && actualLifecycle?.passed === true
      const expected = variant.name === 'candidate' || variant.name === 'restored'
      await writeFile(join(evidence, variant.name + '.log'), run.output)
      assert.equal(passed, expected, JSON.stringify({ variant: variant.name, run, calls, actualLifecycle }))
      if (variant.name.startsWith('eager-')) {
        assert.equal(calls.length, 0); assert.match(run.output, /ERR_MODULE_NOT_FOUND/u); assert.match(run.output, /(?:packages\/core|@agentmux\/core|apps\/host)\/dist\//u)
      }
      if (variant.name === 'duplicate-dependency-build') assert.equal(calls.length, 2)
      if (variant.name === 'disabled-prebuild') { assert.equal(reached, true); assert.equal(actualLifecycle.complete, true); assert.deepEqual(actualLifecycle.stages, []) }
      for (const path of absent) await assert.rejects(readFile(join(own.project, path)), { code: 'ENOENT' })
      receipt.cases.push({ name: variant.name, expected, passed, sourceSHA256: digest(variant.text), originalSHA256: digest(original), actualEntry: true,
        coreAndHostDistAbsent: true, entryExit: run.exit, calls, lifecycle: actualLifecycle, cleaned: true })
    } finally { await rm(own.directory, { recursive: true, force: true }) }
  }
  const loaded = join(evidence, 'installer.loaded.ndjson'), report = join(evidence, 'installer.json')
  for (const path of ['packages/identity/scripts/runtime-bundle.mjs', 'packages/identity/src/runtime-entry.ts', 'packages/identity/src/index.ts', 'pnpm-lock.yaml',
    'packages/core/test/hook-postcommit-observation.vitest.config.mts']) await source(path)
  const { bundleIdentityRuntime } = await import('../../../packages/identity/scripts/runtime-bundle.mjs')
  const identityRuntime = await bundleIdentityRuntime(), identitySource = join(evidence, 'identity-runtime-source.mjs')
  const identityModule = 'export const identityRuntimeSource = ' + JSON.stringify(identityRuntime.source) + ';\n'
  await writeFile(identitySource, identityModule)
  await writeFile(loaded, '')
  const unit = await child(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'apps/desktop/scripts/fixtures/package-bootstrap/vitest.config.mts', '--reporter=json', '--outputFile=' + report],
    { cwd: root, env: { ...process.env, AGENTMUX_PACKAGE_BOOTSTRAP_LOADED: loaded, AGENTMUX_PACKAGE_BOOTSTRAP_IDENTITY: identitySource } })
  await writeFile(join(evidence, 'installer.log'), unit.output)
  const tests = JSON.parse(await readFile(report, 'utf8')), evaluated = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
  assert.equal(unit.exit, 0, unit.output); assert.equal(tests.numFailedTests, 0); assert.ok(tests.numPassedTests > 0); assert.equal(tests.testResults.length, 3)
  assert.ok(evaluated.some(row => row.path === product && row.sha256 === digest(original)), 'The real installer consumer loaded this exact candidate.')
  for (const row of evaluated) assert.equal(digest(await source(row.path)), row.sha256, 'The installer evaluated this exact Source: ' + row.path)
  receipt.installer = { passed: tests.numPassedTests, files: tests.testResults.length, loaded, report,
    generatedIdentity: { path: identitySource, sha256: digest(identityModule), owner: 'packages/identity/scripts/runtime-bundle.mjs' } }
  for (const path of ['apps/desktop/scripts/verify-package-bootstrap.mjs', 'apps/desktop/scripts/fixtures/package-bootstrap/vitest.config.mts']) await source(path)
  receipt.source = Object.fromEntries(inputs)
  for (const [path, hash] of inputs) assert.equal(digest(await readFile(join(root, path))), hash, 'Source changed: ' + path)
  receipt.sourceStable = true
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack }; process.exitCode = 1 }
finally { await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); console.log(join(evidence, 'receipt.json')) }
