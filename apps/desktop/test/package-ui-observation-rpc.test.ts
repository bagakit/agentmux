import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { afterEach, expect, it } from 'vitest'
import { createServer, type Server, type Socket } from 'node:net'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DesktopClientObservation } from '../src/shared/client-observation'

const repository = resolve(import.meta.dirname, '../../..')
const installerPath = process.env.AGENTMUX_UI_OBSERVATION_SOURCE ?? join(repository, 'apps/desktop/scripts/package-runtime-upgrade.mjs')
const installer = await import(pathToFileURL(installerPath).href)
const originalEndpoint = process.env.AGENTMUX_RPC_ENDPOINT
const roots: string[] = []
const servers: Server[] = []
const sockets = new Set<Socket>()

const observation: DesktopClientObservation = {
  schema: 'agentmux.desktop-client-observation.v1',
  main: { pid: 123, package: { schema: 'agentmux.package-identity.v1', sourceCommit: 'private-loaded-source',
    sourceTree: 'private-loaded-tree', appVersion: '1', platform: 'darwin', arch: 'arm64' },
    renderer: { kind: 'bundled', id: 'b'.repeat(64), identity: { shell: 'private-shell', ctxmux: 'private-native' } },
    storage: { userData: _hygiene_fixturePath("private-user-data"), sessionData: _hygiene_fixturePath("private-session-data"), directory: _hygiene_fixturePath("private-storage"),
      localStorage: 'present', detail: null }, runtimes: [] },
  workbench: { loading: false, startupProgress: { step: 'layout' }, activeWorkspaceId: 'workspace', mainSurface: 'workbench',
    focus: { executionSessionId: null, pmoSessionId: null },
    desktop: {
      selection: { surface: 'space', mainSurface: 'workbench', space: { spaceId: 'space', zoneId: 'zone', workspaceId: 'workspace',
        tabId: 'tab', groupId: 'group', regionId: 'file', topicId: null }, goalId: null },
      presentation: { provenance: 'observed', state: 'main-visible', tabId: 'tab', regionId: 'file', blockers: [] },
      input: { provenance: 'observed', scope: 'none', ownerKind: null, tabId: null, regionId: null, sessionId: null,
        connected: false, visible: false, inert: false },
      floating: { provenance: 'observed', state: 'closed', topicId: null, tabId: null, regionId: null, sessionId: null, presentation: 'hidden' },
      overlays: { provenance: 'observed', settings: false, quickSwitcher: false }, focus: { executionSessionId: null, pmoSessionId: null }
    },
    tabs: [{ id: 'tab', workspaceId: 'workspace', titleRegionId: 'file', layout: { root: { type: 'leaf', regionId: 'file' }, activeRegionId: 'file' },
      regions: [{ kind: 'file', regionId: 'file', workspaceId: 'workspace', path: _hygiene_fixturePath("private-file") }] }],
    layouts: { workspace: { root: { type: 'leaf', groupId: 'group' }, activeGroupId: 'group',
      groups: [{ id: 'group', activeTabId: 'tab', tabOrder: ['tab'], recentTabIds: ['tab'] }] } }
  }
}

afterEach(async () => {
  if (originalEndpoint === undefined) delete process.env.AGENTMUX_RPC_ENDPOINT
  else process.env.AGENTMUX_RPC_ENDPOINT = originalEndpoint
  for (const socket of sockets) socket.destroy()
  await Promise.all(servers.splice(0).map(server => new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()))))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(mode: 'success' | 'rpc-error' | 'invalid-observation') {
  const root = await mkdtemp(_hygiene_fixturePath("tmp/amx-ui-reader-")); roots.push(root)
  const endpoint = join(root, 'rpc.sock'), disposed = join(root, 'disposed.txt')
  const core = join(root, 'current.app/Contents/Resources/app/node_modules/@agentmux/core')
  await mkdir(join(core, 'dist'), { recursive: true })
  await writeFile(join(core, 'package.json'), JSON.stringify({ type: 'module' }))
  // The App fixture exports the actual built public SDK. Only dispose recording is added;
  // transport, endpoint selection, wire decoding and calls remain production Core code.
  await writeFile(join(core, 'dist/index.js'), `
import { connectAgentMuxRpc as connect } from ${JSON.stringify(pathToFileURL(join(repository, 'packages/core/dist/index.js')).href)};
import { appendFile } from 'node:fs/promises';
export async function connectAgentMuxRpc(...args) {
  const client = await connect(...args);
  return { call: (...args) => client.call(...args), dispose: async () => {
    await client.dispose(); await appendFile(${JSON.stringify(disposed)}, 'disposed\\n');
  } };
}`)
  const requests: Record<string, unknown>[] = []
  let connections = 0, closed = 0
  const server = createServer(socket => {
    sockets.add(socket); connections++
    socket.on('close', () => { sockets.delete(socket); closed++ })
    let buffer = ''
    socket.on('data', bytes => {
      buffer += String(bytes)
      const end = buffer.indexOf('\n')
      if (end < 0) return
      const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
      requests.push(request)
      const body = mode === 'rpc-error' ? { error: { code: -32000, message: 'Private observation unavailable' } }
        : { result: { observation: mode === 'invalid-observation' ? { ...observation, main: { ...observation.main, pid: 0 } } : observation } }
      // Keep the server side open: the bounded reader must close its own connection.
      socket.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...body }) + '\n')
    })
  })
  servers.push(server)
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(endpoint, done) })
  process.env.AGENTMUX_RPC_ENDPOINT = `unix:${endpoint}`
  return { app: join(root, 'current.app'), requests, disposed, counts: () => ({ connections, closed, open: sockets.size }) }
}

it('reads the current loaded identity and nonempty workbench through the actual public Unix JSON-RPC helper', async () => {
  const f = await fixture('success')
  const read = await installer.observeUiClient(f.app).then((value: unknown) => ({ ok: true, value }), (error: Error) => ({ ok: false, error: error.message }))
  expect(read).toEqual({ ok: true, value: observation })
  expect(f.requests).toEqual([{ jsonrpc: '2.0', id: expect.any(String), method: 'app.inspect', params: {} }])
  expect(await readFile(f.disposed, 'utf8')).toBe('disposed\n')
  expect(f.counts()).toEqual({ connections: 1, closed: 1, open: 0 })
})

it.each(['rpc-error', 'invalid-observation'] as const)('preserves %s and releases the observation connection without a lifecycle request', async mode => {
  const f = await fixture(mode)
  const read = await installer.observeUiClient(f.app).then((value: unknown) => ({ ok: true, value }), (error: Error) => ({ ok: false, error: error.message }))
  expect(read).toMatchObject({ ok: false, error: expect.stringContaining(mode === 'rpc-error' ? 'Private observation unavailable' : 'pid') })
  expect(f.requests).toEqual([{ jsonrpc: '2.0', id: expect.any(String), method: 'app.inspect', params: {} }])
  expect(await readFile(f.disposed, 'utf8')).toBe('disposed\n')
  expect(f.counts()).toEqual({ connections: 1, closed: 1, open: 0 })
})
