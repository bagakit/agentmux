import assert from 'node:assert/strict'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { dirname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

// A private verifier owner, never a discovery/adoption mechanism for existing user services.
const config = JSON.parse(await readFile(process.argv[2], 'utf8'))
for (const path of [config.base, config.packageRoot, config.nodePath, config.claudePath]) assert(isAbsolute(path))
await mkdir(config.base, { mode: 0o700 })
for (const name of ['home', 'claude', 'runtime', 'state', 'workspace']) await mkdir(join(config.base, name), { mode: 0o700 })
const env = { PATH: dirname(config.claudePath) + ':' + dirname(config.nodePath) + ':/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', HOME: join(config.base, 'home'), CLAUDE_CONFIG_DIR: join(config.base, 'claude'),
  AGENTMUX_RUNTIME_DIRECTORY: join(config.base, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(config.base, 'state'), AGENTMUX_AGENT_SESSION_STORE: join(config.base, 'state/sessions.json'),
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${config.modelPort}`, ANTHROPIC_API_KEY: 'isolated-offline-model-key', SHELL: '/bin/bash', USER: process.env.USER || 'proof', TERM: 'xterm-256color', LANG: 'en_US.UTF-8',
  ...(process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}),
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ENABLE_TOOL_SEARCH: 'false', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' }
await writeFile(join(config.base, 'claude/.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, projects: { [join(config.base, 'workspace')]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } }), { mode: 0o600 })
const native = spawn(join(config.packageRoot, 'vendor/ctxmux', process.platform + '-' + process.arch, 'bin/ctxmuxd'), ['--socket', join(config.base, 'runtime/ctxmux.sock'), '--state-dir', join(config.base, 'state/ctxmux'), '--readiness-fd', '3'], { env, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
native.stderr.pipe(createWriteStream(join(config.base, 'native.stderr')))
await Promise.race([once(native.stdio[3], 'data'), once(native, 'exit').then(() => { throw new Error('Private native owner exited before readiness') })])
const runner = `import {startHeadlessAgentMux} from ${JSON.stringify(pathToFileURL(join(config.packageRoot, 'dist/headless-runtime.js')).href)};
import {connectAgentMuxRpc} from ${JSON.stringify(pathToFileURL(join(config.packageRoot, 'dist/public-rpc-client.js')).href)};
import {connectHostedAgentMux} from ${JSON.stringify(pathToFileURL(join(config.packageRoot, 'dist/hosted-client.js')).href)};
let rpc,peer;const remote=${JSON.stringify(config.remote ?? null)};if(remote){rpc=await connectAgentMuxRpc({endpoint:remote});peer=await connectHostedAgentMux({rpc});await peer.connectRuntime()}
const owner=await startHeadlessAgentMux({coreClients:()=>peer?[{hostId:'remote',client:peer}]:[]});console.log(JSON.stringify({socketPath:owner.socketPath,owner:owner.ownerIdentity()}));
process.once('SIGTERM',()=>void owner.stop().then(async()=>{await peer?.dispose();await rpc?.dispose();process.exit(0)}));`
let core, receipt, epoch = 0, stopped = false
async function startCore() {
  core = spawn(config.nodePath, ['--input-type=module', '-e', runner], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  core.stderr.pipe(createWriteStream(join(config.base, 'core-' + epoch++ + '.stderr')))
  const lines = createInterface({ input: core.stdout })
  const [line] = await Promise.race([once(lines, 'line'), once(core, 'exit').then(() => { throw new Error('Private Core exited before readiness') })])
  receipt = { ...JSON.parse(line), base: config.base, corePid: core.pid, nativePid: native.pid, platform: process.platform, architecture: process.arch, node: process.version }
  await writeFile(join(config.base, 'owner.json'), JSON.stringify(receipt, null, 2))
  return receipt
}
const { connectAgentMuxRpc } = await import(pathToFileURL(join(config.packageRoot, 'dist/public-rpc-client.js')))
const { connectHostedAgentMux } = await import(pathToFileURL(join(config.packageRoot, 'dist/hosted-client.js')))
async function stop() {
  if (stopped) return
  stopped = true
  const errors = [], children = []
  let rpc, client
  try {
    rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: receipt.socketPath } }); client = await connectHostedAgentMux({ rpc }); await client.connectRuntime()
    assert.equal(client.runtimeOwnerIdentity().runtimeId, receipt.owner.runtimeId)
    for (const run of await client.listRuns()) if (run.state === 'running') await client.stopTerminal({ runId: run.runId }).catch(error => errors.push(String(error)))
  } catch (error) { errors.push(String(error)) }
  await client?.dispose(); await rpc?.dispose()
  for (const child of [core, native]) {
    if (child.exitCode === null && child.signalCode === null) { const closed = once(child, 'close'); child.kill('SIGTERM'); const [code, signal] = await closed; children.push({ pid: child.pid, code, signal }) }
    else children.push({ pid: child.pid, code: child.exitCode, signal: child.signalCode })
  }
  const result = { stopped: true, errors, children }; await writeFile(join(config.base, 'cleanup.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); process.exit(errors.length ? 1 : 0)
}
try { console.log(JSON.stringify(await startCore())) } catch (error) { native.kill('SIGTERM'); throw error }
process.once('SIGTERM', () => void stop()); process.once('SIGINT', () => void stop())
let queue = Promise.resolve()
createInterface({ input: process.stdin }).on('line', line => {
  queue = queue.then(async () => {
    const request = JSON.parse(line)
    if (request.action === 'stop') { await stop(); return }
    if (request.action !== 'restart-core') throw new Error('Unknown private owner command')
    const previousPid = core.pid, closed = once(core, 'close'); core.kill('SIGTERM'); const [code, signal] = await closed
    assert.equal(code, 0); assert.equal(signal, null)
    console.log(JSON.stringify({ id: request.id, result: { previousPid, code, signal, receipt: await startCore() } }))
  }).catch(error => console.log(JSON.stringify({ error: String(error) })))
})
