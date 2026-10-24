import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { access, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire, isBuiltin } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fixturePath } from './lib/fixture-values.mjs'
import { listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'

const base = resolve(import.meta.dirname, '../../..'), evidence = join(base, '.local/pre-admission-resource-recovery/restart')
const fixture = 'apps/desktop/test/fixtures/agent-creation-pre-admission-restart.tsx'
const runner = 'apps/desktop/scripts/verify-agent-creation-pre-admission-restart.mjs'
const daemonPath = `packages/core/vendor/ctxmux/${process.platform}-${process.arch}/bin/ctxmuxd`
const required = [runner, fixture, 'apps/desktop/scripts/probe-process.mjs', 'packages/core/src/index.ts',
  'apps/desktop/src/main/runtime-controller.ts', 'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/lib/api.ts',
  'apps/desktop/src/renderer/src/components/SessionPane.tsx', 'apps/desktop/src/renderer/src/components/TerminalView.tsx',
  'packages/core/src/client.ts', 'packages/core/src/agent-creation-resource-retry.ts', 'packages/core/src/agent-session-store.ts',
  'packages/core/src/spatial-state.ts', 'packages/core/src/ctxmux-run-adapter.ts', daemonPath,
  ...['index', 'client', 'attachment', 'control', 'validation', 'wire', 'gap-observation', 'stop-operation', 'generated/constants'].map(name => `packages/core/node_modules/@ctxmux/sdk/dist/${name}.js`)]
const hash = value => createHash('sha256').update(value).digest('hex')
const json = async file => JSON.parse(await readFile(file, 'utf8'))
async function check(receipt) {
  assert.equal(receipt.schema, 'agentmux.creation-pre-admission-restart.v1'); assert.equal(receipt.passed, true, receipt.failure)
  for (const file of required) assert.match(receipt.inputs[file] ?? '', /^[a-f0-9]{64}$/, 'Required restart input: ' + file)
  for (const [file, digest] of Object.entries(receipt.inputs)) assert.equal(hash(await readFile(resolve(base, file))), digest, 'Restart candidate changed: ' + file)
  assert.equal(receipt.records.length, 2)
  const [first, second] = receipt.records
  assert.notEqual(first.clientPid, second.clientPid); assert.equal(first.waitWasVisible, true)
  for (const name of ['id', 'cid', 'tabId', 'regionId', 'groupId', 'childPid', 'daemon', 'draft']) assert.equal(first[name], second[name], 'Original ' + name)
  assert.deepEqual(first.run, second.run); assert.deepEqual(first.tabs, second.tabs); assert.deepEqual(first.layouts, second.layouts)
  assert.equal(first.counts.start, 1); assert.equal(first.counts.wait, 1); assert.equal(first.counts.launch, 1)
  assert.equal(first.capacityFailures, 1); assert.deepEqual(first.capacityFault, { code: 'ENOSPC', activeCreations: 1 })
  assert.equal(second.counts.start, 0); assert.equal(second.counts.launch, 0); assert.equal(second.liveRead, true)
  for (const row of receipt.records) {
    assert.equal(row.acceptedInputBytes, 0); assert.equal(row.counts.input, 0); assert.equal(row.counts.stop, 0)
    assert.equal(row.terminalRead, true); assert.ok(row.counts.spatialRead && row.counts.spatialSubscribe && row.counts.attach)
    assert.deepEqual(row.exit, { code: 0, signal: null })
  }
  assert.equal(receipt.cleanup.rootRemoved, true); assert.deepEqual(receipt.cleanup.remaining, []); assert.deepEqual(receipt.cleanup.errors, [])
  await assert.rejects(access(receipt.privateRoot), 'Private root removed')
  assert.match(receipt.bundleSHA256, /^[a-f0-9]{64}$/)
}
if (!process.argv.includes('--run')) {
  await check(await json(join(evidence, 'receipt.json')))
  process.stdout.write('Creation recovery restart: original Native Run, Core spatial workface, Store, mounted Pane/terminal and draft receipt verified\n')
} else {
  await mkdir(evidence, { recursive: true })
  const capacity = join(evidence, 'capacity-preflight')
  const handle = await open(capacity, 'wx'); try { await handle.write(Buffer.alloc(1024)); await handle.sync() } finally { await handle.close(); await rm(capacity) }
  const root = await mkdtemp(fixturePath('tmp/amx-capacity-restart-')), pkg = join(root, 'package')
  const coreRequire = createRequire(join(base, 'packages/core/package.json')), desktopRequire = createRequire(join(base, 'apps/desktop/package.json'))
  const { build } = await import(coreRequire.resolve('esbuild'))
  const inputs = {}, records = [], children = [], cleanupErrors = []
  let failure, bundleSHA256, daemon
  const bind = async file => { const key = relative(base, resolve(base, file)), digest = hash(await readFile(resolve(base, file))); if (inputs[key]) assert.equal(inputs[key], digest, 'Input changed during proof: ' + key); inputs[key] = digest }
  try {
    await mkdir(join(pkg, 'dist'), { recursive: true }); await mkdir(join(root, 'home'), { mode: 0o700 })
    await mkdir(join(root, 'runtime'), { mode: 0o700 }); await mkdir(join(root, 'state', 'ctxmux'), { recursive: true, mode: 0o700 })
    for (const name of ['vendor', 'bin', 'package.json']) await symlink(join(base, 'packages/core', name), join(pkg, name))
    await mkdir(join(pkg, 'node_modules'))
    for (const source of ['apps/desktop/node_modules', 'packages/core/node_modules']) for (const name of await readdir(join(base, source))) {
      if (name.startsWith('@')) {
        await mkdir(join(pkg, 'node_modules', name), { recursive: true })
        for (const child of await readdir(join(base, source, name))) if (!existsSync(join(pkg, 'node_modules', name, child))) await symlink(join(base, source, name, child), join(pkg, 'node_modules', name, child))
      } else if (!existsSync(join(pkg, 'node_modules', name))) await symlink(join(base, source, name), join(pkg, 'node_modules', name))
    }
    const alias = { '@agentmux/identity/runtime-source': join(base, 'packages/identity/dist/runtime-source.js') }
    for (const name of ['core', 'client-ui', 'layout']) {
      const path = join(base, 'packages', name, 'package.json'), manifest = JSON.parse(readFileSync(path, 'utf8'))
      await bind(path)
      for (const [key, value] of Object.entries(manifest.exports)) {
        if (key.includes('*')) continue
        const entry = typeof value === 'string' ? value : value.browser ?? value.types ?? value.import
        const local = join(dirname(path), entry.replace(/^\.\/dist\/(?:src\/)?/, './src/').replace(/\.d\.ts$/, '.ts').replace(/\.js$/, '.ts'))
        if (existsSync(local)) alias[key === '.' ? manifest.name : manifest.name + key.slice(1)] = local
      }
    }
    delete alias['@agentmux/core']
    const coreExports = `
      export { AgentMuxClient, hostAgentCreationIntent } from './client.ts';
      export { AgentMuxFileAgentSessionStore, loadSessionHistorySources } from './agent-session-store.ts';
      export { defineAgentProvider } from './agent-provider.ts';
      export { AgentMuxError } from './errors.ts';
      export { readRoutedInputMailbox } from './agent-global-message-queue.ts';
      export { createInputPerformanceRecorder, hostedCarrierPerformance } from './performance-diagnostics.ts';
      export { parseAgentNativeResumeSource } from './agent-native-sessions.ts';
      export { agentPromptPredecessor, agentPromptNotApplied, validateAgentPromptCondition, validateAgentPromptInputBinding } from './agent-prompt-condition.ts';
      export { runtimeStorageUsage } from './runtime-storage-usage.ts';
      export { agentInteractionResponseUnavailableReason, agentInteractionActiveRequest } from './agent-interaction-state.ts';
      export { LocalExecutionHost, SshExecutionHost } from './execution-host.ts';
      export { connectAgentMuxRpc } from './public-rpc-client.ts';
      export { connectSshAgentMux } from './runtime-client.ts';
      export { defaultAgentMuxControlSocketPath } from './runtime-paths.ts';
      export { observeRead } from './observation-read.ts';
      export { probeSocketLiveness } from './socket-liveness.ts';`
    const publicEntry = await readFile(join(base, 'packages/core/src/index.ts'), 'utf8')
    for (const name of ['client', 'agent-session-store', 'agent-provider', 'errors']) assert.match(publicEntry, new RegExp("export \\* from ['\\\"]\\./" + name + "\\.js['\\\"]"), 'Canonical public Core owner export: ' + name)
    const worker = join(pkg, 'dist', 'worker.mjs'), xterm = desktopRequire.resolve('@xterm/xterm')
    const built = await build({ absWorkingDir: base, entryPoints: [{ in: join(base, fixture), out: 'worker' }], outdir: dirname(worker), outExtension: { '.js': '.mjs' }, chunkNames: 'chunk-[hash]', splitting: true, bundle: true,
      platform: 'node', format: 'esm', target: 'node24', jsx: 'automatic', alias, metafile: true, logLevel: 'silent',
      define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' }, plugins: [{ name: 'source-and-node-host-boundaries', setup(plugin) {
        plugin.onResolve({ filter: /^@agentmux\/core$/ }, () => ({ path: 'actual-owner-exports', namespace: 'node-core' }))
        plugin.onLoad({ filter: /.*/, namespace: 'node-core' }, () => ({ contents: coreExports, loader: 'ts', resolveDir: join(base, 'packages/core/src') }))
        plugin.onResolve({ filter: /\.css$/ }, args => ({ path: args.path, namespace: 'node-styles' }))
        plugin.onLoad({ filter: /.*/, namespace: 'node-styles' }, () => ({ contents: '', loader: 'js' }))
        plugin.onResolve({ filter: /^@agentmux\/(?:core|client-ui)\// }, args => {
          if (alias[args.path]) return null
          const [kind, ...parts] = args.path.slice('@agentmux/'.length).split('/'), subpath = parts.join('/')
          const candidates = kind === 'core' ? ['src/' + subpath + '.ts'] : ['src/' + subpath + '.tsx', 'src/' + subpath + '.ts', 'src/lib/' + subpath + '.ts']
          const found = candidates.map(file => join(base, 'packages', kind, file)).find(existsSync)
          if (found) return { path: found }
          return null
        })
        plugin.onResolve({ filter: /^(electron|@xterm\/xterm|@xterm\/addon-(fit|search|web-links|webgl))$/ }, args => ({ path: args.path, namespace: 'node-boundary' }))
        plugin.onLoad({ filter: /.*/, namespace: 'node-boundary' }, args => ({ loader: 'js', contents: args.path === 'electron'
          ? 'export const app={getAppMetrics:()=>[]};export const nativeImage={createFromBuffer:()=>{throw new Error("No native image decoding in Node proof")}}'
          : args.path === '@xterm/xterm' ? `import actual from ${JSON.stringify(xterm)};export class Terminal extends actual.Terminal{constructor(options){super(options);globalThis.__preAdmissionRestartTerminals.push(this)}}`
          : `export class ${({ fit: 'FitAddon', search: 'SearchAddon', 'web-links': 'WebLinksAddon', webgl: 'WebglAddon' })[args.path.split('addon-')[1]]}{activate(){}dispose(){}fit(){}proposeDimensions(){return {cols:80,rows:24}}onDidChangeResults(){return {dispose(){}}}onContextLoss(){return {dispose(){}}}}` }))
        plugin.onResolve({ filter: /^[^./]/ }, async args => {
          if (isBuiltin(args.path) || alias[args.path] || args.pluginData?.resolving) return null
          const found = await plugin.resolve(args.path, { kind: args.kind, resolveDir: args.resolveDir || join(base, 'apps/desktop'), importer: args.importer, pluginData: { resolving: true } })
          assert.equal(found.errors.length, 0, 'Existing dependency: ' + args.path); await bind(found.path)
          return { path: found.path, external: true }
        })
        plugin.onResolve({ filter: /.*/ }, args => args.path === xterm ? { path: xterm, external: true } : null)
      } }] })
    const contributed = [...new Set(Object.values(built.metafile.outputs).flatMap(output => Object.entries(output.inputs).filter(([, value]) => value.bytesInOutput > 0).map(([file]) => file)).filter(file => !/^node-/u.test(file)))]
    for (const file of required.filter(file => file.includes('/src/') && file !== 'packages/core/src/index.ts')) assert.ok(contributed.includes(file), 'Actual source contributes to the consumed owner: ' + file)
    // Do not bind parsed but tree-shaken public exports, including unused SSH owners.
    for (const file of new Set([...required, ...contributed])) await bind(file)
    await bind(xterm); bundleSHA256 = hash(await readFile(worker))
    await writeFile(join(root, 'pty.mjs'), `import{existsSync,readFileSync}from'node:fs';import{join}from'node:path';process.stdin.setRawMode(true);console.log('ORIGINAL-PROMPT:'+JSON.stringify(process.argv[2]));for(let i=0;i<40;i++)console.log('original-history-'+i);let sent=false;setInterval(()=>{if(!sent&&existsSync(join(${JSON.stringify(root)},'live-output'))){sent=true;console.log(readFileSync(join(${JSON.stringify(root)},'live-output'),'utf8'))}},30)`)
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(AGENTMUX_|CTXMUX_)/u.test(name))), HOME: join(root, 'home'), CODEX_HOME: join(root, 'home'),
      AGENTMUX_RUNTIME_DIRECTORY: join(root, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(root, 'state'), AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson'), AGENTMUX_AGENT_SESSION_STORE: join(root, 'sessions.sqlite'), AGENTMUX_SPATIAL_STATE_STORE: join(root, 'spatial.json') }
    daemon = spawn(join(base, daemonPath), ['--socket', join(root, 'runtime', 'ctxmux.sock'), '--state-dir', join(root, 'state', 'ctxmux'), '--readiness-fd', '3'], { env, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
    let daemonErrors = ''; daemon.stderr.on('data', value => { daemonErrors = (daemonErrors + value).slice(-4096) })
    await Promise.race([once(daemon.stdio[3], 'data'), once(daemon, 'exit').then(([code]) => { throw new Error('Private Native exited before readiness: ' + code + ' ' + daemonErrors) })])
    for (const mode of ['first', 'second']) {
      const child = spawn(process.execPath, [worker, mode, root], { cwd: base, env, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child)
      let stdout = '', stderr = ''; child.stdout.on('data', value => { stdout = (stdout + value).slice(-65536) }); child.stderr.on('data', value => { stderr = (stderr + value).slice(-12288) })
      const timer = setTimeout(() => child.kill('SIGKILL'), 45000)
      try { const [code, signal] = await once(child, 'exit'); assert.equal(code, 0, stderr); assert.equal(signal, null)
        records.push({ ...JSON.parse(stdout.trim().split('\n').at(-1)), exit: { code, signal } })
      } finally { clearTimeout(timer) }
    }
    for (const [file, digest] of Object.entries(inputs)) assert.equal(hash(await readFile(resolve(base, file))), digest, 'Exact input remained: ' + file)
  } catch (error) { failure = error.stack ?? String(error) }
  finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    try { await stopProbeProcesses(-1, root, 1500) } catch (error) { cleanupErrors.push(String(error)) }
    if (daemon?.exitCode === null && daemon?.signalCode === null) { const exited = once(daemon, 'exit'); daemon.kill('SIGTERM'); await exited }
    const remaining = await listProbeProcesses(-1, root)
    if (!remaining.length && !cleanupErrors.length) await rm(root, { recursive: true, force: true })
    const receipt = { schema: 'agentmux.creation-pre-admission-restart.v1', passed: !failure && !remaining.length && !cleanupErrors.length,
      inputs, bundleSHA256, privateRoot: root, records, failure: failure ?? null,
      cleanup: { rootRemoved: !existsSync(root), remaining, errors: cleanupErrors },
      scope: 'Two real Node host processes, current source Core/RuntimeController/Store/SpatialStateStore, actual private ctxmuxd/PTy and mounted production SessionPane/TerminalView/xterm. DOM layout and optional addons are Node boundary substitutes; no Electron pixels, no user Run.' }
    await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
    if (!receipt.passed) { console.error(receipt.failure); process.exitCode = 1 }
    else { await check(receipt); console.log('Creation recovery restart: two real hosts preserved original workface and Native Run; private resources removed') }
  }
}
