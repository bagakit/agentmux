import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { AgentMuxControlServer, AgentMuxFileAgentSessionStore, connectAgentMuxRpc, type AgentMuxSpaceCatalog } from '@agentmux/core'
import { startAgentMuxHost } from '../../../../host/src/host'
import { FileReadOwner } from '../../../src/main/file-read-owner'
import { WorkspaceFiles } from '../../../src/main/workspace-files'
import type { WorkspaceRecord } from '../../../src/shared/contracts'

// Two original production endpoints; no Agent or user Runtime is created.
const root = process.env.FILE_READ_PROBE_ROOT!, artifact = process.env.FILE_READ_PROBE_DAEMON!
const runtime = join(root, 'runtime'), state = join(root, 'state'), path = join(root, 'workspace')
await Promise.all([mkdir(runtime, { mode: 0o700 }), mkdir(state, { mode: 0o700 }), mkdir(path)])
await mkdir(join(state, 'ctxmux'), { mode: 0o700 }); await mkdir(join(path, 'mote'))
await writeFile(join(path, 'mote/saved.md'), 'Original material through the real Host.\n')
const daemon = spawn(artifact, ['--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(state, 'ctxmux'), '--readiness-fd', '3'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
let nativeError = ''; daemon.stderr!.on('data', bytes => { nativeError += bytes })
const workspace: WorkspaceRecord = { id: 'original-files', hostId: 'local', path, name: 'Files', kind: 'folder' }
const catalog: AgentMuxSpaceCatalog = { spaces: [], zones: [{ zoneId: 'original-zone', workspaceId: workspace.id, hostId: workspace.hostId, directoryPath: join(path, 'mote'), kind: 'home', branch: null }],
  tabs: [], regions: [], locations: [], bindings: [{ spaceId: 'mote-space', zoneId: 'original-zone' }] }
const files = new WorkspaceFiles(() => ({ id: 'local', kind: 'local' }) as never)
let reads = 0
const owner = new FileReadOwner({ catalog: async () => catalog, workspace: id => id === workspace.id ? workspace : undefined,
  files: { read: async (...args) => { reads++; return await files.read(...args) } } })
const desktop = new AgentMuxControlServer({ socketPath: join(runtime, 'control.sock.desktop'), files: owner, coreClients: () => [] })
let host: Awaited<ReturnType<typeof startAgentMuxHost>> | undefined
const cli = promisify(execFile)
try {
  await Promise.race([once(daemon.stdio[3]!, 'data'), once(daemon, 'exit').then(() => { throw new Error(nativeError) })])
  await desktop.start()
  host = await startAgentMuxHost({ store: new AgentMuxFileAgentSessionStore(join(state, 'sessions.json')), providers: [],
    socketPath: join(runtime, 'control.sock'), desktopSocketPath: desktop.path })
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: host.server.path } })
  try {
    const params = { zoneId: 'original-zone', spaceId: 'mote-space', path: 'saved.md', expectedResource: { hostId: 'local', workspaceId: workspace.id, workspacePath: path } }
    const result = await client.call('file.read', params)
    assert.equal(result.result.status, 'read')
    assert.equal(result.resource?.workspacePath, path)
    if (result.result.status !== 'read') throw new Error('The real original file must read.')
    assert.equal(result.result.document.content, 'Original material through the real Host.\n')
    assert.match(result.result.document.revision, /^sha256:[0-9a-f]{64}$/u)
    const args = ['--endpoint', 'unix:' + host.server.path, 'file', 'read', '--zone', params.zoneId, '--space', params.spaceId, '--path', params.path,
      '--host', 'local', '--workspace', workspace.id, '--workspace-path', path]
    const success = await cli(process.execPath, [process.env.FILE_READ_PROBE_CLI!, ...args], { env: process.env })
    assert.deepEqual(JSON.parse(success.stdout).result, result)
    assert.equal(reads, 2)
    await assert.rejects(client.call('file.read', { ...params, expectedResource: { ...params.expectedResource, hostId: 'foreign-host' } }),
      { code: 'FILE_RESOURCE_MISMATCH' })
    assert.equal(reads, 2)
    console.log(JSON.stringify({ passed: true, productionHost: host.server.path !== desktop.path, originalReads: reads,
      savedRevision: result.result.document.revision, originalResource: result.resource, healthySessions: host.client.agentSessions().length,
      boundary: 'Private ctxmux/Host with no Agent; actual shared forwardControl, Desktop Files and CLI, no user App or package.' }))
  } finally { await client.dispose() }
} finally {
  await host?.dispose(); await desktop.stop(); await files.dispose()
  if (daemon.exitCode === null && daemon.signalCode === null) { daemon.kill('SIGTERM'); await once(daemon, 'exit') }
}
