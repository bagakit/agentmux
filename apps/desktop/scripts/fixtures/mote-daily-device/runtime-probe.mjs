import { fixturePath as _hygiene_fixturePath } from "../../lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, statfs, symlink, writeFile } from 'node:fs/promises'
import { join, resolve, relative, dirname } from 'node:path'

const digest = value => createHash('sha256').update(value).digest('hex')
export async function probeDeviceGoalRuntime({ repository, evidence, mainRef } = {}) {
  const repo = resolve(repository ?? new URL('../../../../..', import.meta.url).pathname)
  const dependencyRoot = dirname(resolve(repo, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: repo, encoding: 'utf8' }).trim()))
  mainRef ??= execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: repo, encoding: 'utf8' }).trim()
  evidence = resolve(evidence ?? join(repo, '.tmp/mote-daily-device', String(globalThis.crypto.randomUUID())))
  await mkdir(evidence, { recursive: true })
  const disk = await statfs(evidence)
  assert.ok(disk.bavail * disk.bsize > 80 * 1024 * 1024, 'Private Runtime proof needs 80 MiB free; no daemon has started')
  const privateRoot = await realpath(await mkdtemp(_hygiene_fixturePath("tmp/ame-"))), source = join(privateRoot, 'source')
  const receipt = { schema: 'agentmux.mobile-goal.original-runtime-recovery.v1', taskId: 'T-005', passed: false, mainRef, phases: [], source: {},
    userRunTouched: false, generated: {}, inputs: [], limitations: [
      'Two private Node Host processes, the original Headless Core owner, RuntimeController and one private ctxmuxd.',
      'The original repository native Codex protocol fixture is used. A real OS-open native Session record supplies Core discovery; the original input/body/Run and unknown continuation retry are observed, not injected ACKs.',
      'Original DeviceWorkfaceStore and LauncherState persist their own navigation and unsent drafts through a private Storage port across both Host PIDs. No user App/Run, model response, actual Renderer/layout/composer or public agent.open qualification is claimed here.',
      'The existing mobile helpers and device owner call the original hosted SDK and public Goal service, production Store.executeControl and original Main Manager. No live Relay, device OS, Renderer, model response or public agent.open claim.' ] }
  let daemon, owner, requestId = 0, daemonStderr = '', stopped = false
  const exits = new WeakMap()
  const logs = []
  const stopChild = async child => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    const exited = exits.get(child) ?? once(child, 'exit'); child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
    try { await exited } finally { clearTimeout(timer) }
  }
  try {
    await mkdir(source)
    const platform = `${process.platform}-${process.arch}`
    execFileSync('tar', ['-x', '-C', source], { input: execFileSync('git', ['archive', mainRef,
      'packages/core/src', 'packages/core/package.json', 'packages/core/bin', `packages/core/vendor/ctxmux/${platform}`,
      'packages/core/test/fixtures/fake-codex-cli.mjs', 'apps/desktop/src', 'apps/desktop/package.json',
      'packages/demand', 'packages/layout', 'packages/client-ui', 'packages/relay', 'apps/mobile/src',
      'apps/desktop/resources/settings-banner.png', 'apps/desktop/resources/icon-128.png'], { cwd: repo, maxBuffer: 50 * 1024 * 1024 }) })
    const overlay = ['apps/mobile/src/navigation/goal-work.ts', 'apps/mobile/src/recovery/device-workface.ts',
      'apps/desktop/scripts/fixtures/mote-daily-device/runtime-owner.ts']
    for (const name of overlay) { await mkdir(dirname(join(source, name)), { recursive: true }); await cp(join(repo, name), join(source, name)) }
    for (const name of ['node_modules', 'apps/desktop/node_modules', 'packages/core/node_modules', 'packages/relay/node_modules', 'packages/demand/node_modules', 'packages/layout/node_modules', 'packages/client-ui/node_modules']) {
      const available = await realpath(join(repo, name)).catch(error => { if (error.code !== 'ENOENT') throw error; return realpath(join(dependencyRoot, name)) })
      await mkdir(dirname(join(source, name)), { recursive: true }); await symlink(available, join(source, name))
    }
    const require = createRequire(join(repo, 'apps/desktop/package.json')), { build } = createRequire(require.resolve('vite'))('esbuild')
    const aliases = { electron: join(source, 'apps/desktop/scripts/fixtures/agent-schedules/electron.ts') }
    await mkdir(dirname(aliases.electron), { recursive: true }); await writeFile(aliases.electron, execFileSync('git', ['show', mainRef + ':apps/desktop/scripts/fixtures/agent-schedules/electron.ts'], { cwd: repo }))
    for (const name of ['core', 'demand', 'layout', 'relay']) {
      const pkg = join(source, 'packages', name), manifest = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'))
      for (const [key, value] of Object.entries(manifest.exports)) {
        const target = typeof value === 'string' ? value : value.import
        if (!target || target.endsWith('.json')) continue
        aliases['@agentmux/' + name + (key === '.' ? '' : key.slice(1))] = resolve(pkg, target.replace('./dist/', name === 'core' || name === 'relay' ? './src/' : './').replace(/\.js$/, '.ts'))
      }
    }
    const helper = join(privateRoot, 'workspace-move')
    const bound = new Map()
    const plugin = { name: 'same-directory-private-source', setup(builder) {
      builder.onResolve({ filter: /\?(worker|url)$/ }, args => ({ path: args.path, namespace: 'unused-dom-resource' }))
      builder.onLoad({ filter: /.*/, namespace: 'unused-dom-resource' }, args => ({ loader: 'js', contents: args.path.endsWith('?worker')
        ? "export default class UnusedPrivateDomWorker { constructor() { throw new Error('DOM preview workers are not available in this private Node Goal consumer'); } }"
        : "export default 'unused-private-dom-resource';" }))
      builder.onResolve({ filter: /^@agentmux\/client-ui(?:\/|$)/ }, async args => {
        const manifest = JSON.parse(await readFile(join(source, 'packages/client-ui/package.json'), 'utf8'))
        const key = args.path === '@agentmux/client-ui' ? '.' : './' + args.path.slice('@agentmux/client-ui/'.length)
        const entry = manifest.exports[key] ?? Object.entries(manifest.exports).find(([name]) => name.includes('*') && key.startsWith(name.split('*')[0]))?.[1]
        const pattern = Object.keys(manifest.exports).find(name => name.includes('*') && key.startsWith(name.split('*')[0]))
        const value = typeof entry === 'string' ? entry : entry?.browser
        assert.ok(value, 'Original client-ui Source export required: ' + key)
        return { path: resolve(source, 'packages/client-ui', value.replace('*', pattern ? key.slice(pattern.split('*')[0].length) : '')) }
      })
      builder.onLoad({ filter: /\.(ts|tsx|mjs|js|json)$/ }, async args => {
        if (!args.path.startsWith(source + '/') || args.path.includes('/node_modules/')) return null
        const bytes = await readFile(args.path), logical = relative(source, args.path); bound.set(logical, digest(bytes)); receipt.source[logical] = digest(bytes)
        if (args.path.endsWith('/scratch-directory-identity.mjs') || args.path.endsWith('/scratch-directory-maintenance.mjs')) {
          const text = bytes.toString('utf8'), anchor = "const defaultHelper = resolve(import.meta.dirname, '../../resources/bin/agentmux-workspace-move')"
          assert.equal(text.split(anchor).length, 2, 'One original helper relocation seam required')
          return { contents: text.replace(anchor, 'const defaultHelper = process.env.DIRECTORY_RUNTIME_HELPER'), loader: 'js' }
        }
        return null
      })
    } }
    const options = { bundle: true, platform: 'node', format: 'esm', alias: aliases,
      external: ['@ctxmux/sdk', 'fs-native-extensions'], plugins: [plugin], logLevel: 'error', metafile: true, define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
      // Inherited lazy DOM previews are compiled but never opened by this Node consumer. Their
      // styles and asset URLs carry no UI qualification here; actual Mobile Renderer review is separate.
      loader: { '.css': 'empty', '.png': 'dataurl', '.svg': 'dataurl', '.ttf': 'dataurl', '.wasm': 'dataurl' },
      banner: { js: "import { createRequire as privateRequire } from 'node:module'; const require=privateRequire(import.meta.url);" } }
    const bundle = join(source, 'packages/core/dist/device-owner.mjs'); await mkdir(dirname(bundle), { recursive: true })
    await build({ ...options, entryPoints: [join(source, 'apps/desktop/scripts/fixtures/mote-daily-device/runtime-owner.ts')], outfile: bundle })
    await build({ ...options, entryPoints: [join(source, 'packages/core/src/agentmux.ts')], outfile: join(source, 'packages/core/dist/agentmux.js') })
    const originalCli = join(source, 'packages/core/test/fixtures/fake-codex-cli.mjs'), nativeCli = join(privateRoot, 'native-observer.mjs')
    const nativeCode = `import {statSync,readFileSync,writeFileSync,appendFileSync,openSync,mkdirSync} from 'node:fs';\nimport {pathToFileURL} from 'node:url';\nimport {join} from 'node:path';\nconst records=join(process.env.DIRECTORY_RUNTIME_PRIVATE_ROOT,'native-records');mkdirSync(records,{recursive:true});const record=join(records,'rollout-original.jsonl');writeFileSync(record,JSON.stringify({type:'session_meta',payload:{id:'native-'+process.env.AGENTMUX_AGENT_SESSION_ID,source:'cli',cwd:process.cwd()}})+'\\n');const heldOriginalRecord=openSync(record,'r');let sequence=0;\nprocess.stdin.on('data',b=>{appendFileSync(join(process.env.DIRECTORY_RUNTIME_PRIVATE_ROOT,'native-input.ndjson'),JSON.stringify({sequence:++sequence,data:String(b)})+'\\n');const s=statSync('.',{bigint:true});process.stdout.write('DIRECTORY_RUNTIME_CWD:'+JSON.stringify({pid:process.pid,input:String(b),cwd:process.cwd(),object:{dev:String(s.dev),ino:String(s.ino)},note:readFileSync('note.md','utf8'),oldAddressNote:readFileSync(process.env.DIRECTORY_RUNTIME_ORIGINAL_ALIAS+'/note.md','utf8')})+'\\n')});\nawait import(pathToFileURL(${JSON.stringify(originalCli)}).href);\n`
    await writeFile(nativeCli, nativeCode); receipt.generated.nativeObserver = { sha256: digest(nativeCode), qualification: 'Reads its own cwd/Note through original Core output. Holds one real original Codex-format Session record, as the repository native discovery fixture does; Core observes its OS FD and owns native identity/readiness.' }
    for (const directory of ['runtime', 'state/ctxmux', 'home']) await mkdir(join(privateRoot, directory), { recursive: true, mode: 0o700 })
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('AGENTMUX_') && !name.startsWith('CTXMUX_'))),
      HOME: join(privateRoot, 'home'), AGENTMUX_RUNTIME_DIRECTORY: join(privateRoot, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(privateRoot, 'state'),
      AGENTMUX_AGENT_SESSION_STORE: join(privateRoot, 'state/sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(privateRoot, 'state/messages.ndjson'),
      DIRECTORY_RUNTIME_PRIVATE_ROOT: privateRoot, DIRECTORY_RUNTIME_HELPER: helper, DIRECTORY_RUNTIME_NATIVE_CLI: nativeCli }
    const artifact = join(source, 'packages/core/vendor/ctxmux', platform, 'bin/ctxmuxd')
    receipt.artifact = { file: relative(source, artifact), sha256: digest(await readFile(artifact)) }
    receipt.source = Object.fromEntries(bound)
    assert.ok(Object.keys(receipt.source).length > 100, 'The real Core/controller imports cannot be empty')
    receipt.overlays = {}
    for (const name of overlay) receipt.overlays[name] = digest(await readFile(join(source, name)))
    for (const name of ['apps/desktop/scripts/fixtures/mote-daily-device/runtime-probe.mjs']) receipt.source[name] = digest(await readFile(join(repo, name)))
    receipt.source['packages/core/test/fixtures/fake-codex-cli.mjs'] = digest(await readFile(originalCli))
    receipt.harnessSource = Object.fromEntries(['apps/desktop/scripts/fixtures/mote-daily-device/runtime-owner.ts',
      'apps/desktop/scripts/fixtures/mote-daily-device/runtime-probe.mjs'].map(name => [name, receipt.source[name]]))
    receipt.excludedDomPorts = 'Original lazy Monaco/PDF previews are not used by this Node Goal consumer. Worker construction throws; asset URLs are private placeholders. No DOM/preview/rendering health is claimed.'
    receipt.sourceOrigins = Object.fromEntries(Object.keys(receipt.source).map(name => [name, name in receipt.harnessSource ? 'candidate-harness' : overlay.includes(name) ? 'candidate-overlay' : mainRef]))
    daemon = spawn(artifact, ['--socket', join(privateRoot, 'runtime/ctxmux.sock'), '--state-dir', join(privateRoot, 'state/ctxmux'), '--readiness-fd', '3'],
      { env, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
    exits.set(daemon, once(daemon, 'exit'))
    daemon.stderr.on('data', part => daemonStderr += String(part))
    await new Promise((yes, no) => { const timer = setTimeout(() => no(new Error('Private official daemon readiness timed out: ' + daemonStderr)), 20000)
      daemon.stdio[3].once('data', () => { clearTimeout(timer); yes() }); daemon.once('error', error => { clearTimeout(timer); no(error) })
      daemon.once('exit', code => { clearTimeout(timer); no(new Error('Private daemon exited ' + code + ': ' + daemonStderr)) }) })
    receipt.daemonPid = daemon.pid
    async function boot(phase) {
      owner = spawn(process.execPath, [bundle], { env: { ...env, DIRECTORY_RUNTIME_PHASE: phase }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
      exits.set(owner, once(owner, 'exit'))
      let stdout = '', stderr = ''
      owner.stdout.on('data', b => stdout += b); owner.stderr.on('data', b => stderr += b)
      logs.push({ phase, child: owner, read: () => ({ stdout, stderr }) })
      const ready = await new Promise((yes, no) => { const timer = setTimeout(() => no(new Error('Private Host readiness timed out: ' + stderr)), 45000)
        const consume = () => { for (const line of stdout.split('\n').slice(0, -1)) { try { const value = JSON.parse(line); if (value.ready || phase === 'cleanup' && value.passed) { clearTimeout(timer); owner.stdout.off('data', consume); yes(value); return } } catch {} } }
        owner.stdout.on('data', consume); owner.once('error', error => { clearTimeout(timer); no(error) }); owner.once('exit', code => { clearTimeout(timer); no(new Error('Private Host exited ' + code + ': ' + stderr)) }) })
      receipt.phases.push(ready); return ready
    }
    async function command(action) {
      const request = ++requestId, current = owner
      const reply = new Promise((yes, no) => { const timer = setTimeout(() => { current.off('message', receive); no(new Error('Private command timed out: ' + action)) }, 45000)
        function receive(value) { if (value.request !== request) return; clearTimeout(timer); current.off('message', receive); value.error ? no(new Error(value.error.message + '\n' + value.error.stack)) : yes(value.result) }
        current.on('message', receive); current.once('error', no) })
      current.send({ request, action }); return await reply
    }
    const first = await boot('seed'); receipt.seed = first
    const cliParams = { goalId: 'goal' }
    const cliOutput = execFileSync(process.execPath, [join(source, 'packages/core/dist/agentmux.js'), 'goal', 'inspect', '--goal', 'goal'],
      { env: { ...env, AGENTMUX_RPC_ENDPOINT: 'unix:' + first.socketPath }, timeout: 15000, maxBuffer: 2 * 1024 * 1024 }).toString()
    await writeFile(join(evidence, 'source-cli-inspect.log'), cliOutput)
    const cliResult = JSON.parse(cliOutput.trim().split('\n').at(-1)); assert.equal(cliResult.ok, true); assert.equal(cliResult.result.goal.id, 'goal')
    assert.deepEqual(cliResult.result.goal.sessionIds, [first.target.agentSessionId]); receipt.sourceCli = { method: 'goal.inspect', params: cliParams, result: cliResult, logSha256: digest(cliOutput) }
    receipt.pause = await command('pause-lost-ack')
    receipt.inputs.push(await command('input'))
    const beforeRestart = await command('detach'); receipt.beforeRestart = beforeRestart; await exits.get(owner); owner = undefined
    const second = await boot('restore'); receipt.restored = second
    assert.notEqual(first.pid, second.pid); assert.equal(first.owner.runtimeId, second.owner.runtimeId); assert.notEqual(first.owner.ownerInstanceId, second.owner.ownerInstanceId)
    for (const field of ['target', 'session', 'device', 'launcher']) assert.deepEqual(second[field], beforeRestart[field], 'Original durable ' + field + ' survives another real Host PID')
    for (const field of ['runId', 'pid', 'workspacePath', 'state']) assert.equal(second.run[field], beforeRestart.run[field], 'Same original Run ' + field)
    assert.deepEqual(second.goal, beforeRestart.goal, 'Original durable Goal survives another PID')
    assert.deepEqual(second.loop, beforeRestart.loop, 'The same frozen original loop and pending operation survive another PID')

    assert.equal(second.run.acceptedInputBytes, beforeRestart.run.acceptedInputBytes, 'Restart does not replay missed ticks or native input')
    receipt.retry = await command('retry-original')
    receipt.inputs.push(await command('input'))
    receipt.result = await command('result')
    receipt.final = await command('stop'); stopped = true; await exits.get(owner); owner = undefined
    const nativeBytes = await readFile(join(privateRoot, 'native-input.ndjson')), chunks = nativeBytes.toString().trim().split('\n').map(line => JSON.parse(line))
    const body = chunks.map(chunk => chunk.data).join('')
    assert.ok(body.includes('Produce the original useful result.')); for (const input of receipt.inputs) assert.ok(body.includes(input.label))
    assert.ok(chunks.every((chunk, index) => chunk.sequence === index + 1))
    await writeFile(join(evidence, 'native-input.ndjson'), nativeBytes)
    receipt.nativeOrderedInput = { path: 'native-input.ndjson', sha256: digest(nativeBytes), chunks: chunks.length,
      initialPrompt: 'Produce the original useful result.', manualInputs: receipt.inputs.map(input => input.label) }
    for (const name of ['packages/core/src/hosted-client.ts', 'packages/core/src/public-rpc-service.ts',
      'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/main/continuous-progress-loop-manager.ts',
      'apps/desktop/src/main/runtime-controller.ts', 'apps/mobile/src/navigation/goal-work.ts', 'apps/mobile/src/recovery/device-workface.ts'])
      assert.ok(receipt.source[name], 'An actual compiled original caller cannot be absent: ' + name)
    // Each Host's transcript is cumulative. Preserve it once rather than counting earlier
    // snapshots again as additional public operations.
    receipt.actualCalls = [...receipt.beforeRestart.publicCalls, ...receipt.final.publicCalls]
    receipt.actualControlCalls = [...receipt.beforeRestart.controlCalls, ...receipt.final.controlCalls]
    receipt.actualCallees = [
      { source: 'apps/mobile/src/navigation/goal-work.ts', symbol: 'sendGoalOperation', caller: 'apps/desktop/scripts/fixtures/mote-daily-device/runtime-owner.ts' },
      { source: 'packages/core/src/hosted-client.ts', symbol: 'connectHostedAgentMux.forwardRpc', methods: ['goal.ls', 'goal.inspect', 'goal.continuation-action'] },
      { source: 'packages/core/src/public-rpc-service.ts', symbol: 'AgentMuxRpcService.execute', operations: ['demand.list', 'demand.show', 'demand.continuation-action'] },
      { source: 'apps/desktop/src/renderer/src/store.ts', symbol: 'useAppStore.executeControl', caller: 'startHeadlessAgentMux.service.execute' },
      { source: 'apps/desktop/src/main/continuous-progress-loop-manager.ts', symbol: 'ContinuousProgressLoopManager.goalAction', caller: 'api.continuousProgress.goalAction' },
      { source: 'apps/desktop/src/main/runtime-controller.ts', symbol: 'RuntimeController.write', evidence: 'Actual original Run ordered native-input.ndjson and manual input output' }
    ]
    for (const phase of [receipt.beforeRestart, receipt.final]) {
      assert.equal(phase.hostedOwner.runtimeId, phase.owner.runtimeId)
      assert.equal(phase.hostedOwner.ownerInstanceId, phase.owner.ownerInstanceId)
      assert.ok(phase.session.nativeHandle.sessionId); assert.equal(typeof phase.run.acceptedInputBytes, 'number')
      for (const call of phase.publicCalls) {
        assert.equal(call.context.runtimeFence.runtimeId, phase.owner.runtimeId)
        assert.equal(call.context.runtimeFence.ownerInstanceId, phase.owner.ownerInstanceId)
      }
    }
    for (const method of ['goal.ls', 'goal.inspect', 'goal.continuation-action']) assert.ok(receipt.actualCalls.some(call => call.method === method))
    for (const operation of ['demand.list', 'demand.show', 'demand.continuation-action']) assert.ok(receipt.actualControlCalls.some(call => call.request.operation === operation))
    receipt.operation = receipt.pause.operation
    receipt.noDuplicateNativeInput = receipt.retry.before.run.acceptedInputBytes === receipt.retry.after.run.acceptedInputBytes
    receipt.sourceChanges = []
    for (const [name, original] of Object.entries({ ...receipt.overlays, ...receipt.harnessSource })) if (digest(await readFile(join(repo, name))) !== original) receipt.sourceChanges.push(name)
    assert.deepEqual(receipt.sourceChanges, [], 'Only stable candidate overlays qualify the Native observations')
    receipt.consumerRecovery = 'Two actual SDK connections reopen the same durable semantic Runtime across two real Host PIDs. A single in-memory SDK object surviving an OS/device restart and live Relay transport are not claimed.'
    receipt.passed = true
  } catch (error) { receipt.error = { message: error.message, stack: error.stack } }
  finally {
    const errors = []
    try { await stopChild(owner); owner = undefined } catch (error) { errors.push('Host stop: ' + error.message) }
    for (const row of logs) { const text = row.read(); await writeFile(join(evidence, row.phase + '.stdout.log'), text.stdout); await writeFile(join(evidence, row.phase + '.stderr.log'), text.stderr) }
    // If a partial create reached Core, reopen only this private Store and stop its exact recorded Session.
    if (!stopped && daemon && daemon.exitCode === null) {
      try {
        await readFile(join(privateRoot, 'target.json'))
        const child = spawn(process.execPath, [join(source, 'packages/core/dist/device-owner.mjs')], { env: {
          ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('AGENTMUX_') && !name.startsWith('CTXMUX_'))),
          HOME: join(privateRoot, 'home'), AGENTMUX_RUNTIME_DIRECTORY: join(privateRoot, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(privateRoot, 'state'),
          AGENTMUX_AGENT_SESSION_STORE: join(privateRoot, 'state/sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(privateRoot, 'state/messages.ndjson'),
          DIRECTORY_RUNTIME_PRIVATE_ROOT: privateRoot, DIRECTORY_RUNTIME_PHASE: 'cleanup', DIRECTORY_RUNTIME_HELPER: join(privateRoot, 'workspace-move'), DIRECTORY_RUNTIME_NATIVE_CLI: join(privateRoot, 'native-observer.mjs') }, stdio: ['ignore', 'pipe', 'pipe'] })
        let text = ''; child.stdout.on('data', b => text += b); child.stderr.on('data', b => text += b)
        const timer = setTimeout(() => child.kill('SIGKILL'), 20000), [code, signal] = await once(child, 'exit'); clearTimeout(timer)
        await writeFile(join(evidence, 'cleanup-host.log'), text); assert.equal(code, 0, text); assert.equal(signal, null); stopped = true
      } catch (error) { if (error.code !== 'ENOENT') errors.push('Private exact Run stop: ' + error.message) }
    }
    try { await stopChild(daemon) } catch (error) { errors.push('Daemon stop: ' + error.message) }
    await writeFile(join(evidence, 'daemon.stderr.log'), daemonStderr)
    await mkdir(join(evidence, 'source-retention'), { recursive: true })
    for (const [name, hash] of Object.entries(receipt.overlays ?? {})) { const bytes = await readFile(join(source, name)); assert.equal(digest(bytes), hash); await writeFile(join(evidence, 'source-retention', hash), bytes) }
    receipt.preservedOverlaySource = Object.fromEntries(Object.entries(receipt.overlays ?? {}).map(([name, sha256]) => [name, { sha256, blob: 'source-retention/' + sha256 }]))
    receipt.cleanup = { errors, exactPrivateRunStopped: stopped, daemonExitCode: daemon?.exitCode ?? null, daemonSignal: daemon?.signalCode ?? null,
      privateRootRemoved: false }
    if (!errors.length) { await rm(privateRoot, { recursive: true, force: true }); receipt.cleanup.privateRootRemoved = true }
    if (errors.length) receipt.passed = false
    await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2))
  }
  assert.equal(receipt.passed, true, receipt.error?.message ?? receipt.cleanup.errors.join('\n'))
  return receipt
}

if (process.argv[1] === new URL(import.meta.url).pathname) { await probeDeviceGoalRuntime(); }
