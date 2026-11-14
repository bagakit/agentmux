import { mkdir, readFile, writeFile, access as fileAccess } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { appendFileSync, writeFileSync } from 'node:fs'
import { AgentMuxFileAgentSessionStore, defaultAgentMuxControlSocketPath } from '../../../../packages/core/src/index.ts'
import { startAgentMuxHost } from '../../src/host.ts'
const path = defaultAgentMuxControlSocketPath(), root = dirname(process.env.AGENTMUX_AGENT_SESSION_STORE)
const directory = join(root, 'initial-mobile')
await mkdir(join(directory, 'assets'), { recursive: true })
const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex')
const source = 'export const initialMobileFixture = true;'
const html = '<!doctype html><title>Private original mobile owner</title><script type="module" src="./assets/app.js"></script>'
await writeFile(join(directory, 'index.html'), html); await writeFile(join(directory, 'assets/app.js'), source)
const body = { schema: 'agentmux.mobile-web-release.v1', buildId: process.env.MOBILE_WEB_INITIAL_BUILD ? JSON.parse(process.env.MOBILE_WEB_INITIAL_BUILD) : 'private-initial', files: [
  { path: 'assets/app.js', bytes: Buffer.byteLength(source), digest: digest(source) },
  { path: 'index.html', bytes: Buffer.byteLength(html), digest: digest(html) }] }
await writeFile(join(directory, 'mobile-release.json'), JSON.stringify({ ...body, digest: digest(JSON.stringify(body)) }))
const configurationPath = join(root, 'original-configuration.json')
try { await fileAccess(configurationPath) } catch { await writeFile(configurationPath, JSON.stringify({ workspaces: [{ id: 'original-workspace', hostId: 'local', name: 'Original Workspace', kind: 'folder', path: dirname(root) }], executors: { codex: { providerId: 'codex', label: 'Original Codex' } }, appearance: {} })) }
// This explicit private test option only selects the production outbound file owner.
const outboundTest = process.env.OUTBOUND_RELAY_TEST ? JSON.parse(process.env.OUTBOUND_RELAY_TEST) : null
const outboundPath = outboundTest ? join(root, 'outbound-relay-test.json') : null
if (outboundTest) await writeFile(outboundPath, JSON.stringify({ relay: outboundTest.relay, publisherToken: outboundTest.publisherToken, allowedClientKeys: outboundTest.allowedClientKeys }), { mode: 0o600 })
const host = await startAgentMuxHost({ store: new AgentMuxFileAgentSessionStore(process.env.AGENTMUX_AGENT_SESSION_STORE),
  configurationPath, socketPath: path, desktopSocketPath: path + '.desktop', mobileBuildDirectory: directory, mobilePort: 0,
  ...(outboundPath ? { outboundRelayConfigurationPath: outboundPath } : {}) })
if (outboundTest?.holdOperationId) {
  // Fault seam: Core still authorizes and executes every request. Withhold only the
  // selected original response *after* its real owner returned, then cut its network.
  const open = host.server.openAuthenticatedFrames.bind(host.server)
  host.server.openAuthenticatedFrames = options => {
    const requests = new Map()
    const frames = open({ ...options, send: async frame => {
      const request = requests.get(frame.id)
      if (request?.operationId === outboundTest.holdOperationId && Object.hasOwn(frame, 'result')) {
        writeFileSync(join(root, 'outbound-held-response.json'), JSON.stringify({ operationId: request.operationId, method: request.method, result: frame.result }), { mode: 0o600 })
        await new Promise(resolve => {
          if (options.authorization.signal?.aborted) resolve()
          else options.authorization.signal?.addEventListener('abort', resolve, { once: true })
        })
        return
      }
      return await options.send(frame)
    } })
    return { ...frames, receive: async frame => {
      if (frame.method === 'agent.input.submit') {
        const request = { method: frame.method, operationId: frame.params.operationId }
        requests.set(frame.id, request)
        appendFileSync(join(root, 'outbound-input-dispatch.jsonl'), JSON.stringify(request) + '\n', { mode: 0o600 })
      }
      return await frames.receive(frame)
    } }
  }
}
const { owner } = await host.hosted.call('runtime.owner.identity', {})
// These are this test's freshly generated public offer facts; no user device is consulted.
const publicKey = JSON.parse(await readFile(join(root, 'agentmux-relay-keypair.json'), 'utf8')).publicKeyB64
const access = host.mobileAccessState(), port = host.mobilePort(), origin = port ? new URL('http://127.0.0.1:' + port + '/') : null
const offer = { v: 2, serverId: (await host.deviceAuthority()).hostId, daemonPublicKeyB64: publicKey,
  relay: { endpoint: '127.0.0.1:' + (origin?.port ?? '0'), useTls: false } }
await writeFile(join(root, 'mobile-test-owner.json'), JSON.stringify({ owner, access, origin: origin ? 'http://127.0.0.1:' + origin.port + '/' : null, offer }), { mode: 0o600 })
process.stdout.write(JSON.stringify({ owner, socketPath: path }) + '\n')
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void host.dispose().then(() => process.exit(0), error => { console.error(error); process.exit(1) }) })
