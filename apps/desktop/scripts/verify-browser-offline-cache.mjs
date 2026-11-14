import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, stat, realpath } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, stopProbeProcesses, listProbeProcesses } from './probe-process.mjs'
const root = resolve(import.meta.dirname, '../../..'), require = createRequire(join(root, 'apps/desktop/package.json'))
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild'), electron = require('electron')
const evidence = join(root, '.bagakit/feature-tracker/browser-offline-cache-management'); await mkdir(evidence, { recursive: true })
const nativeDiagnostic = process.argv.includes('--native-diagnostic')
const report = { passed: false, source: {}, tests: [], native: [], cleanup: [] }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
report.dependency = { electron: await realpath(electron), electronVersion: require('electron/package.json').version, sha256: sha(await readFile(electron)), protobufVersion: JSON.parse(await readFile(join(root, 'apps/desktop/node_modules/@bufbuild/protobuf/package.json'), 'utf8')).version }
const save = () => writeFile(join(evidence, nativeDiagnostic ? 'native-diagnostic.json' : 'main-verification.json'), JSON.stringify(report, null, 2) + '\n')
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key) && key !== 'ELECTRON_RUN_AS_NODE'))
const alias = {}
for (const folder of ['packages/core', 'packages/browser', 'packages/client-ui', 'apps/host']) {
  const dir = join(root, folder), pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
  for (const [key, entry] of Object.entries(pkg.exports)) {
    const value = typeof entry === 'string' ? entry : entry.import
    if (typeof value !== 'string' || key.includes('*')) continue
    const source = resolve(dir, value.replace(/^\.\/dist\/(?:src\/)?/u, './src/').replace(/\.js$/u, '.ts'))
    try { await stat(source); alias[pkg.name + (key === '.' ? '' : key.slice(1))] = source } catch { /* Type-only/non-source export is not needed. */ }
  }
}
const temporary = await mkdtemp('/tmp/amux-offline-cache-')
try {
  for (const mutant of nativeDiagnostic ? [] : ['baseline', 'unknown-replay', 'selected-keys', 'save-before-dispatch', 'owner-path', 'partition-key', 'restored']) {
    const logs = [], result = await runProbeProcess(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'apps/desktop/test/browser-offline-cache.config.mts'], {
      cwd: root, env: { ...env, ...(mutant === 'baseline' || mutant === 'restored' ? {} : { AGENTMUX_OFFLINE_CACHE_MUTANT: mutant }) }, timeoutMs: 60_000, onLine: line => logs.push(line)
    })
    await stopProbeProcesses(result.originalPid, temporary)
    const remaining = await listProbeProcesses(result.originalPid, temporary)
    report.tests.push({ mutant, result, remaining, output: logs.join('\n') }); await save()
    if (mutant === 'baseline' || mutant === 'restored') assert.equal(result.exitCode, 0, logs.join('\n'))
    else { assert.notEqual(result.exitCode, 0, `${mutant} must fail`); assert.match(logs.join('\n'), /AssertionError|FAIL|failed/u, 'mutation must reach a behavioral assertion') }
    assert.deepEqual(remaining, []); console.log(`Offline cache ${mutant}: ${result.exitCode}`)
  }
  const cli = join(temporary, 'cli.mjs')
  await build({ entryPoints: [join(root, 'packages/core/src/agentmux.ts')], outfile: cli, platform: 'node', target: 'node24', format: 'esm', bundle: true, packages: 'external', alias,
    banner: { js: "import{createRequire as __r}from'node:module';const require=__r(import.meta.url);" } })
  report.cliSha256 = sha(await readFile(cli))
  await symlink(join(root, 'packages/core/node_modules'), join(temporary, 'node_modules'))
  const nativeMutants = {
    'native-mask': ['apps/desktop/src/main/browser-profile-storage-native.ts', "storageTypes: 'cache_storage'", "storageTypes: 'all'"],
    'native-key': ['apps/desktop/src/main/browser-profile-storage-native.ts', '{ storageKey, storageTypes:', "{ storageKey: storageKey.split('^')[0], storageTypes:"]
  }
  for (const name of ['candidate', ...Object.keys(nativeMutants), 'restored']) {
    const out = join(temporary, name); await mkdir(out)
    await symlink(join(root, 'apps/desktop/node_modules'), join(out, 'node_modules'))
    const main = join(out, 'main.mjs'); let mutation = null
    await build({ entryPoints: [join(root, 'apps/desktop/scripts/fixtures/browser-offline-cache/main.ts')], outfile: main, platform: 'node', target: 'node24', format: 'esm', bundle: true, packages: 'external', alias, external: ['electron'],
      banner: { js: "import{createRequire as __r}from'node:module';const require=__r(import.meta.url);" }, plugins: [{ name: 'native-offline-cache-candidate', setup(bundler) {
        bundler.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async args => {
          if (!args.path.startsWith(root + '/') || args.path.includes('/node_modules/')) return
          const original = await readFile(args.path, 'utf8'); let code = original
          report.source[relative(root, args.path)] = sha(original)
          if (nativeMutants[name]?.[0] === relative(root, args.path)) {
            const [, before, after] = nativeMutants[name]; assert.equal(code.split(before).length, 2)
            code = code.replace(before, after); mutation = { path: relative(root, args.path), before: sha(original), after: sha(code) }
          }
          return { contents: code, loader: args.path.endsWith('.tsx') ? 'tsx' : 'ts' }
        })
      } }] })
    const home = join(out, 'home'); await mkdir(home)
    for (const phase of name === 'candidate' ? ['seed', 'restart'] : ['seed']) {
      const resultPath = join(out, phase + '.json'), bootstrap = join(out, phase + '.cjs')
      await writeFile(bootstrap, `const{app}=require('electron'),fs=require('node:fs'),path=require('node:path');for(const key of ['appData','userData','sessionData']){const p=path.join(${JSON.stringify(home)},key);fs.mkdirSync(p,{recursive:true});app.setPath(key,p)}app.whenReady().then(()=>import(${JSON.stringify(pathToFileURL(main).href)})).catch(e=>{console.error(e);app.exit(1)});`)
      const logs = [], result = await runProbeProcess(electron, [bootstrap], { cwd: home,
        env: { ...env, AGENTMUX_RUNTIME_DIRECTORY: home, AGENTMUX_STATE_DIRECTORY: join(home, 'state'), AGENTMUX_AGENT_SESSION_STORE: join(home, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(home, 'messages.ndjson'), AGENTMUX_OFFLINE_HOME: home, AGENTMUX_OFFLINE_OUTPUT: resultPath, AGENTMUX_OFFLINE_PHASE: phase, AGENTMUX_OFFLINE_CLI: cli },
        timeoutMs: 120_000, onLine: line => { logs.push(line); console.log(`[${name}/${phase}] ${line}`) } })
      await stopProbeProcesses(result.originalPid, home)
      const remaining = await listProbeProcesses(result.originalPid, home)
      let actual = null; try { actual = JSON.parse(await readFile(resultPath, 'utf8')) } catch { /* Missing proof is failure. */ }
      report.native.push({ name, phase, result, remaining, actual, mutation, bundleSha256: sha(await readFile(main)), log: logs.join('\n') }); await save()
      assert.deepEqual(remaining, [])
      if (nativeMutants[name]) { assert.ok(mutation); assert.equal(actual?.passed, false); assert.match(actual?.error ?? '', /AssertionError/u) }
      else { assert.equal(result.exitCode, 0, actual?.error ?? logs.join('\n')); assert.equal(actual?.passed, true) }
    }
  }
  report.passed = true
} finally {
  await rm(temporary, { recursive: true, force: true }); report.cleanup.push({ path: temporary, removed: true }); await save()
}
assert.equal(report.passed, true)
console.log('Offline cache Main/native/mutation proof passed; temporary builds and isolated Profile data removed.')
