import { browserSourceBuild } from '../../../packages/browser/scripts/source-build.mjs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire, isBuiltin } from 'node:module'
import { mkdir, readFile, writeFile, symlink, readdir, lstat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, stopProbeProcesses, listProbeProcesses } from './probe-process.mjs'
import { privatePackageSmokeEnvironment } from './package-smoke-context.mjs'

const root = resolve(import.meta.dirname, '../../..'), args = process.argv.slice(2), outputFlag = args.indexOf('--output')
const output = resolve(outputFlag < 0 ? join(root, '.tmp/browser-clipboard-permissions/electron-' + Date.now()) : args[outputFlag + 1])
const interactive = args.includes('--interactive')
for (let index = 0; index < args.length; index++) { if (args[index] === '--output') { assert.ok(args[++index]); continue }; assert.equal(args[index], '--interactive') }
const require = createRequire(join(root, 'apps/desktop/package.json')), { build } = browserSourceBuild(createRequire(require.resolve('vite'))('esbuild')), exec = promisify(execFile)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const workspacePackages = new Map()
for (const area of ['packages', 'apps']) for (const name of await readdir(join(root, area))) {
  try { const manifest = JSON.parse(await readFile(join(root, area, name, 'package.json'), 'utf8')); workspacePackages.set(manifest.name, { directory: join(root, area, name), manifest }) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
}
await mkdir(output, { recursive: false })
for (const path of ['user-data/home', 'session-data', 'runtime/tmp']) await mkdir(join(output, path), { recursive: true })
await mkdir(join(output, 'node_modules'))
for (const area of ['apps/desktop', 'packages/core']) {
  const modules = join(root, area, 'node_modules')
  for (const entry of await readdir(modules)) {
    if (entry.startsWith('.')) continue
    const names = entry.startsWith('@') ? (await readdir(join(modules, entry))).map(name => entry + '/' + name) : [entry]
    for (const name of names) {
      const target = join(output, 'node_modules', name)
      try { await lstat(target) } catch (error) {
        if (error.code !== 'ENOENT') throw error
        if (name.startsWith('@')) await mkdir(join(output, 'node_modules', name.split('/')[0]), { recursive: true })
        await symlink(join(modules, name), target)
      }
    }
  }
}
const fixture = join(root, 'apps/desktop/scripts/fixtures/browser-clipboard-permissions')
const binary = join(output, 'pasteboard'), compiled = join(output, 'main.mjs'), bootstrap = join(output, 'bootstrap.cjs')
const receipt = { schema: 'agentmux.browser-clipboard-electron-receipt.v1', passed: false, output, sources: {}, artifacts: {}, remaining: [] }
let originalPid
try {
  const { bundleIdentityRuntime } = await import(pathToFileURL(join(root, 'packages/identity/scripts/runtime-bundle.mjs')).href)
  const { source: identityRuntimeSource } = await bundleIdentityRuntime()
  const generatedIdentity = join(output, 'identity-runtime-source.mjs')
  await writeFile(generatedIdentity, `export const identityRuntimeSource=${JSON.stringify(identityRuntimeSource)}`)
  const swift = await exec('/usr/bin/xcrun', ['swiftc', '-O', join(fixture, 'pasteboard.swift'), '-o', binary], { maxBuffer: 1024 * 1024 })
  await writeFile(join(output, 'swift.log'), swift.stderr)
  const dependencies = {}
  const built = await build({ absWorkingDir: root, entryPoints: [join(fixture, 'main.ts')], outfile: compiled, bundle: true, platform: 'node', format: 'esm', target: 'node24', metafile: true, logLevel: 'silent', plugins: [{ name: 'current-workspace-source', setup(build) {
    build.onResolve({ filter: /^@agentmux\// }, args => {
      const [scope, name, ...subpath] = args.path.split('/'), owner = workspacePackages.get(scope + '/' + name)
      if (!owner) return
      const exported = owner.manifest.exports?.[subpath.length ? './' + subpath.join('/') : '.']
      const entry = typeof exported === 'string' ? exported : exported?.import ?? exported?.default ?? owner.manifest.main
      assert.ok(typeof entry === 'string', 'Resolve exact workspace export: ' + args.path)
      if (args.path === '@agentmux/identity/runtime-source') return { path: generatedIdentity }
      return { path: resolve(owner.directory, entry.replace(/^\.\/dist\/(?:src\/)?/, './src/').replace(/\.js$/, '.ts')) }
    })
    build.onResolve({ filter: /^[^./]/ }, async args => {
      if (args.pluginData?.resolvedDependency) return
      if (args.path === 'electron' || isBuiltin(args.path)) return { path: args.path, external: true }
      const resolved = await build.resolve(args.path, { resolveDir: args.resolveDir, kind: 'import-statement', pluginData: { resolvedDependency: true } })
      if (resolved.errors.length) return { errors: resolved.errors }
      const path = resolved.path
      dependencies[path] = true
      return { path, external: true }
    })
  } }] })
  receipt.dependencies = Object.fromEntries(await Promise.all(Object.keys(dependencies).map(async path => [path, sha(await readFile(path))])))
  for (const path of [...Object.keys(built.metafile.inputs), 'packages/identity/src/index.ts', 'packages/identity/src/runtime-entry.ts', 'packages/identity/scripts/runtime-bundle.mjs', 'apps/desktop/scripts/fixtures/browser-clipboard-permissions/pasteboard.swift', 'apps/desktop/scripts/verify-browser-clipboard-permissions-electron.mjs', 'apps/desktop/scripts/probe-process.mjs', 'apps/desktop/scripts/package-smoke-context.mjs', 'pnpm-lock.yaml']) receipt.sources[path] = sha(await readFile(resolve(root, path)))
  assert.ok(Object.keys(receipt.sources).some(path => path === 'apps/desktop/src/main/browser-view-manager.ts'))
  assert.ok(Object.keys(receipt.sources).some(path => path === 'apps/desktop/src/main/browser-session-permissions.ts'))
  await writeFile(bootstrap, `const {app}=require('electron');app.setPath('userData',${JSON.stringify(join(output, 'user-data'))});app.setPath('sessionData',${JSON.stringify(join(output, 'session-data'))});if(process.platform==='darwin')app.setActivationPolicy('accessory');import('./main.mjs').catch(error=>{console.error(error);app.exit(1)})`)
  for (const path of ['main.mjs', 'pasteboard', 'bootstrap.cjs']) receipt.artifacts[path] = sha(await readFile(join(output, path)))
  const executable = process.env.AGENTMUX_CLIPBOARD_ELECTRON_EXECUTABLE || require('electron')
  receipt.electron = { executable, sha256: sha(await readFile(executable)) }
  const environment = { ...privatePackageSmokeEnvironment(process.env, { userData: join(output, 'user-data'), runtimeRoot: join(output, 'runtime'), readyFile: join(output, 'unused-ready') }), CLIPBOARD_PROBE_ROOT: output, CLIPBOARD_PROBE_HELPER: binary, CLIPBOARD_PROBE_INTERACTIVE: interactive ? '1' : '0' }
  delete environment.ELECTRON_RUN_AS_NODE
  const logs = []
  try {
    receipt.process = await runProbeProcess(executable, [bootstrap], { cwd: root, env: environment, timeoutMs: interactive ? 12 * 60_000 : 40_000, onSpawn: r => { originalPid = r.originalPid }, onLine: line => logs.push(line) })
    receipt.result = JSON.parse(await readFile(join(output, 'receipt.json'), 'utf8'))
    assert.equal(receipt.process.exitCode, 0, 'The exact original Electron process must exit successfully')
    assert.equal(receipt.result.passed, true)
    assert.equal(receipt.result.writes.length, 2)
    assert.ok(receipt.result.writes.every(write => write.system.state === 'confirmed'))
    assert.equal(receipt.result.clipboardAfter.restored, true)
    receipt.passed = true
  } finally { await writeFile(join(output, 'process.log'), logs.join('\n')) }
} catch (error) { receipt.failure = error.stack; if (error.probe) receipt.process = error.probe }
finally {
  if (originalPid) { await stopProbeProcesses(originalPid, output); receipt.remaining = await listProbeProcesses(originalPid, output) }
  for (const [path, hash] of Object.entries(receipt.sources)) assert.equal(sha(await readFile(resolve(root, path))), hash, 'Probe source stayed unchanged: ' + path)
  await writeFile(join(output, 'runner-receipt.json'), JSON.stringify(receipt, null, 2))
}
console.log(JSON.stringify({ output, passed: receipt.passed, process: receipt.process, remaining: receipt.remaining, failure: receipt.failure }, null, 2))
process.exitCode = receipt.passed ? 0 : 1
