import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess } from './probe-process.mjs'
import { prepareRemoteProofCandidate } from './remote-runtime-proof-candidate.mjs'

const desktop = path.resolve(import.meta.dirname, '..'), root = path.resolve(desktop, '../..')
const fixture = path.join(desktop, 'scripts/fixtures/remote-runtime-renderer')
const require = createRequire(path.join(desktop, 'package.json'))
const hash = value => createHash('sha256').update(value).digest('hex')
const files = async directory => (await Promise.all((await fs.readdir(directory, { withFileTypes: true })).map(entry => entry.isDirectory()
  ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat()

/** Private proof input. Unix substitutes only the transport selector; SSH uses the product path
 * without a selector shim. The coordinator owns remote deployment/restart and process cleanup. */
export async function runRemoteDesktopProof({ privateRoot, evidence, input, ownerCommand, electron }) {
  input = structuredClone(input)
  assert.equal(input.schema, 'agentmux.remote-runtime-native-input.v1')
  assert.ok(['unix', 'ssh'].includes(input.remoteEndpoint.transport))
  assert.equal(input.config.hosts.filter(host => host.kind === 'ssh').length, 1)
  assert.equal(input.config.hosts.find(host => host.id === input.identity.hostId)?.runtimeId, input.identity.runtimeId)
  assert.ok(['fixture-marker', 'accepted-input-output'].includes(input.inputProbe?.kind), 'The private caller selects its input oracle explicitly')
  assert.ok(typeof input.inputProbe.text === 'string' && input.inputProbe.text.length > 0)
  if (input.remoteEndpoint.transport === 'ssh') assert.equal(input.inputProbe.kind, 'accepted-input-output', 'A real SSH Provider uses public accepted input/output facts')
  input.localHealth ??= { workspacePath: path.join(privateRoot, 'local-workspace'), command: process.execPath,
    args: ['-e', "process.stdin.setRawMode(true);process.stdout.write('LOCAL_READY\\r\\n');process.stdin.on('data',data=>process.stdout.write('LOCAL_INPUT:'+data+'\\r\\n'));"], inputText: 'p' }
  await fs.mkdir(input.localHealth.workspacePath, { recursive: true })
  if (!input.config.workspaces.some(workspace => workspace.hostId === 'local')) input.config.workspaces.push({
    id: 'private-local-workspace', name: 'Private local health', hostId: 'local', path: input.localHealth.workspacePath, kind: 'folder' })
  const proof = { schema: 'agentmux.remote-runtime-native-proof.v1', passed: false, transport: input.remoteEndpoint.transport,
    selectorBoundary: input.remoteEndpoint.transport === 'unix' ? 'Only the production Desktop Host connector public SSH import selects public RPC plus Hosted SDK over private Unix; all owner/Provider/Store/ctxmux APIs are real.'
      : 'Main uses its production Desktop Host connector and public SSH Hosted SDK with the supplied bound Host configuration.',
    userAppRunTouched: false, phases: [], inputBefore: null, inputAfter: null, aestheticReview: 'not-performed' }
  await fs.mkdir(evidence, { recursive: true })
  await fs.mkdir(path.join(privateRoot, 'node_modules/@agentmux'), { recursive: true })
  const candidate = await prepareRemoteProofCandidate({ root, privateRoot, proof })
  await fs.symlink(candidate.core, path.join(privateRoot, 'node_modules/@agentmux/core'))
  const inputPath = path.join(privateRoot, 'remote-input.json')
  await fs.writeFile(inputPath, JSON.stringify(input, null, 2))
  const preload = path.join(privateRoot, 'preload.cjs')
  await fs.copyFile(path.join(fixture, 'preload.cjs'), preload)
  const { build } = await import(pathToFileURL(require.resolve('vite')).href)
  const selector = path.join(privateRoot, 'hosted-unix-transport-selector.mjs')
  const mainProduct = path.join(desktop, 'src/main/desktop-host.ts')
  let selectorTransform
  if (input.remoteEndpoint.transport === 'unix') {
    const original = pathToFileURL(path.join(candidate.core, 'dist/index.js')).href
    const hosted = pathToFileURL(path.join(candidate.core, 'dist/hosted.js')).href
    const bytes = `import { connectAgentMuxRpc } from ${JSON.stringify(original)};
import { connectHostedAgentMux } from ${JSON.stringify(hosted)};
export * from ${JSON.stringify(original)};
export async function connectSshAgentMux(options) {
  const rpc = await connectAgentMuxRpc({ endpoint: ${JSON.stringify(input.remoteEndpoint)} });
  try {
    const client = await connectHostedAgentMux({ rpc,
      ...(options.expectedRuntimeId === undefined ? {} : { expectedRuntimeId: options.expectedRuntimeId }),
      ...(options.waitForReady === undefined ? {} : { waitForReady: options.waitForReady }),
      ...(options.consumerId === undefined ? {} : { consumerId: options.consumerId }),
      forwardRpc: (method, params, context = {}) => rpc.call(method, params, {
        ...(context.signal === undefined ? {} : { signal: context.signal }),
        ...(context.caller === undefined ? {} : { credentials: context.caller }),
        ...(context.runtimeFence === undefined ? {} : { runtimeFence: context.runtimeFence })
      })
    });
    const dispose = client.dispose.bind(client);
    client.dispose = async () => { try { await dispose(); } finally { await rpc.dispose(); } };
    return client;
  } catch (error) { await rpc.dispose(); throw error; }
}\n`
    await fs.writeFile(selector, bytes)
    proof.selectorSHA256 = hash(bytes)
    selectorTransform = { name: 'private-unix-transport-selector', enforce: 'pre', transform(code, id) {
      if (id.split('?')[0] !== mainProduct) return
      assert.equal(code.split("from '@agentmux/core'").length - 1, 1, 'Exactly the public import owns this private selector boundary')
      const consumed = code.replace("from '@agentmux/core'", `from ${JSON.stringify(selector)}`)
      proof.mainSelector = { product: path.relative(root, mainProduct), originalSHA256: hash(code), consumedSHA256: hash(consumed) }
      return { code: consumed, map: null }
    } }
  }
  let lastRequest, ownerOperation
  const pump = async () => {
    if (ownerOperation) return
    let request
    try { request = JSON.parse(await fs.readFile(path.join(privateRoot, 'owner-request.json'), 'utf8')) }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return; throw error }
    if (request.id === lastRequest) return
    lastRequest = request.id
    ownerOperation = (async () => {
      let response
      try { assert.ok(['stop', 'restart', 'terminal-noise-start', 'terminal-noise-stop'].includes(request.operation)); response = { id: request.id, result: await ownerCommand(request.operation) } }
      catch (error) { response = { id: request.id, error: error.message } }
      await fs.writeFile(path.join(privateRoot, 'owner-response.json'), JSON.stringify(response))
    })().finally(() => { ownerOperation = undefined })
    await ownerOperation
  }
  let poll
  try {
    await build({ configFile: false, root: fixture, base: './', logLevel: 'error', esbuild: { jsx: 'automatic' },
      plugins: [candidate.capture],
      define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"', __TERMINAL_WHEEL_UMD_URL__: '"unused"' },
      resolve: { alias: [{ find: /^@xterm\/xterm$/, replacement: path.join(desktop, 'scripts/fixtures/terminal-wheel/xterm-instrumented.ts') }] },
      build: { target: 'esnext', outDir: path.join(privateRoot, 'renderer'), emptyOutDir: true } })
    await build({ configFile: false, root: fixture, logLevel: 'error', plugins: [candidate.capture, ...(selectorTransform ? [selectorTransform] : [])],
      build: { ssr: path.join(fixture, 'main.ts'), target: 'node22', outDir: path.join(privateRoot, 'main'), emptyOutDir: true,
        rollupOptions: { external: id => id === 'electron' || id === '@agentmux/core' || id.startsWith('@agentmux/core/') || id.startsWith('file:'),
          output: { format: 'es', entryFileNames: 'main.mjs' } } } })
    await candidate.buildHost(build)
    await candidate.seal()
    const immutableInputs = async () => ({ ...await candidate.identity(), ...Object.fromEntries(await Promise.all([
      ...await files(path.join(privateRoot, 'renderer')), ...await files(path.join(privateRoot, 'main')),
      preload, inputPath, ...(input.remoteEndpoint.transport === 'unix' ? [selector] : [])
    ].map(async file => [file.startsWith(privateRoot + '/') ? path.relative(privateRoot, file) : 'fixture/preload.cjs', hash(await fs.readFile(file))]))) })
    proof.compiledInputs = await immutableInputs()
    proof.inputBefore = proof.compiledInputs
    if (input.remoteEndpoint.transport === 'unix') assert.ok(proof.mainSelector, 'The private Unix selector was consumed')
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    poll = setInterval(() => { void pump().catch(error => { proof.coordinatorFailure = error.message }) }, 20)
    for (const phase of ['seed', 'restore']) {
      const phaseRoot = path.join(privateRoot, `phase-${phase}`); await fs.mkdir(phaseRoot)
      const stderr = []
      const exit = await runProbeProcess(electron ?? process.env.AGENTMUX_PROOF_ELECTRON_PATH ?? require('electron'),
        [path.join(privateRoot, 'main/main.mjs'), path.join(privateRoot, 'renderer/index.html'), privateRoot, phase,
          preload, evidence, process.execPath, inputPath],
        { temporaryRoot: phaseRoot, cwd: root, env, timeoutMs: input.terminalReading ? 300000 : 90000, onLine: line => stderr.push(line) })
      await fs.writeFile(path.join(evidence, `${phase}-stderr.log`), stderr.join('\n'))
      const recorded = { phase, exit, native: null }
      proof.phases.push(recorded)
      assert.equal(exit.timedOut, false, 'The ordinary Electron proof exceeded its private watchdog')
      assert.equal(exit.exitCode, 0)
      const native = JSON.parse(await fs.readFile(path.join(evidence, `${phase}.json`), 'utf8'))
      recorded.native = native
      assert.equal(native.passed, true, native.failure?.message)
    }
    assert.equal(new Set(proof.phases.map(item => item.native.pid)).size, 2)
    const ownerGenerations = proof.phases.map(item => item.native.remoteIdentity.owner.ownerInstanceId)
    assert.equal(new Set(ownerGenerations).size, 2, 'The two phases saw different real owner generations')
    assert.deepEqual(proof.phases.map(item => [item.native.remoteIdentity.status.session.agentSessionId,
      item.native.remoteIdentity.status.run.runId, item.native.remoteIdentity.status.run.pid, item.native.remoteIdentity.status.session.nativeHandle]),
    [0, 1].map(() => [input.identity.sessionId, input.identity.run.runId, input.identity.pid, input.identity.nativeHandle]))
    assert.deepEqual(proof.phases.map(item => [item.native.localIdentity.runId, item.native.localIdentity.pid]),
      [0, 1].map(() => [proof.phases[0].native.localIdentity.runId, proof.phases[0].native.localIdentity.pid]))
    assert.deepEqual(proof.phases.map(item => [item.native.localHostOwner.runtimeId,
      item.native.localHostOwner.ownerInstanceId, item.native.localHostOwner.processId]),
      [0, 1].map(() => [proof.phases[0].native.localHostOwner.runtimeId,
        proof.phases[0].native.localHostOwner.ownerInstanceId, proof.phases[0].native.localHostOwner.processId]),
      'The original local semantic Host survives both ordinary Electron generations')
    proof.inputAfter = await immutableInputs()
    assert.deepEqual(proof.inputAfter, proof.inputBefore, 'The actually consumed private compiled candidate changed')
    assert.equal(proof.coordinatorFailure, undefined)
    proof.passed = true
  } catch (error) { proof.failure = { name: error.name, message: error.message, stack: error.stack } }
  finally {
    clearInterval(poll); if (ownerOperation) await ownerOperation
    let localClient
    const errors = []
    let remaining = []
    try {
      let local
      try { local = JSON.parse(await fs.readFile(path.join(privateRoot, 'local-health.json'), 'utf8')) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      if (local || proof.phases.length) {
        localClient = await candidate.connectLocalHost()
        const runs = await localClient.listRuns()
        if (local) {
          const run = runs.find(item => item.runId === local.runId)
          assert.ok(run); assert.equal(run.pid, local.pid)
          await localClient.stopTerminal({ runId: local.runId })
        } else {
          // A failed first receipt can still have admitted the private health Run.
          // This confirmed Store/socket belongs only to the current proof.
          for (const run of runs) if (run.state === 'running') await localClient.stopTerminal({ runId: run.runId })
        }
      }
    } catch (error) { errors.push(error.message) }
    try { await localClient?.dispose() } catch (error) { errors.push(error.message) }
    try { remaining = await candidate.stopHost() } catch (error) { errors.push(error.message) }
    proof.localCleanup = { errors, remaining, scope: 'The exact private local Store and its native Runtime directory' }
    if (errors.length || proof.localCleanup.remaining.length) proof.passed = false
    await fs.writeFile(path.join(evidence, 'native-receipt.json'), JSON.stringify(proof, null, 2) + '\n')
  }
  assert.equal(proof.passed, true, proof.failure?.message)
  return proof
}
