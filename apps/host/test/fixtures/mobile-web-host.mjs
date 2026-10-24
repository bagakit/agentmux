import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { AgentMuxFileAgentSessionStore, defaultAgentMuxControlSocketPath } from '../../../../packages/core/src/index.ts'
import { startAgentMuxHost } from '../../src/host.ts'
const path = defaultAgentMuxControlSocketPath(), root = dirname(process.env.AGENTMUX_AGENT_SESSION_STORE)
const directory = join(root, 'initial-mobile')
await mkdir(join(directory, 'assets'), { recursive: true })
const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex')
const source = 'export const initialMobileFixture = true;'
const html = '<!doctype html><title>Private original mobile owner</title><script type="module" src="./assets/app.js"></script>'
await writeFile(join(directory, 'index.html'), html); await writeFile(join(directory, 'assets/app.js'), source)
const body = { schema: 'agentmux.mobile-web-release.v1', buildId: 'private-initial', files: [
  { path: 'assets/app.js', bytes: Buffer.byteLength(source), digest: digest(source) },
  { path: 'index.html', bytes: Buffer.byteLength(html), digest: digest(html) }] }
await writeFile(join(directory, 'mobile-release.json'), JSON.stringify({ ...body, digest: digest(JSON.stringify(body)) }))
const host = await startAgentMuxHost({ store: new AgentMuxFileAgentSessionStore(process.env.AGENTMUX_AGENT_SESSION_STORE),
  socketPath: path, desktopSocketPath: path + '.desktop', mobileBuildDirectory: directory, mobilePort: 0 })
const { owner } = await host.hosted.call('runtime.owner.identity', {})
// These are this test's freshly generated public offer facts; no user device is consulted.
const publicKey = JSON.parse(await readFile(join(root, 'agentmux-relay-keypair.json'), 'utf8')).publicKeyB64
const access = host.mobileAccessState(), origin = new URL(access.origin)
const offer = { v: 2, serverId: (await host.deviceAuthority()).hostId, daemonPublicKeyB64: publicKey,
  relay: { endpoint: '127.0.0.1:' + origin.port, useTls: false } }
await writeFile(join(root, 'mobile-test-owner.json'), JSON.stringify({ owner, origin: 'http://127.0.0.1:' + origin.port + '/', offer }), { mode: 0o600 })
process.stdout.write(JSON.stringify({ owner, socketPath: path }) + '\n')
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void host.dispose().then(() => process.exit(0), error => { console.error(error); process.exit(1) }) })
