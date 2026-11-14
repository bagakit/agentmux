import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { vi } from 'vitest'
import { AgentMuxFileAgentSessionStore, connectAgentMuxRpc } from '@agentmux/core'
import { startAgentMuxHost } from '../../../host/src/host.js'
import { configuredDesktopAgentMuxHost } from '../../src/main/desktop-host.js'
import { RuntimeController } from '../../src/main/runtime-controller.js'

/** Two actual Source services and private vendored Native daemons. All Zone and
 * Space identities come from Source folder registration, never a fixture graph.
 * Main uses its production local carrier factory; only the configured map is a leaf. */
export async function sourceFilesHosts(cleanup: Array<() => unknown | Promise<unknown>>, options: { scratch?: boolean; sharedProject?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'amx-source-files-'))
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 }))
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key) && !key.startsWith('AGENTMUX_TEST_')) vi.stubEnv(key, undefined)
  const helper = resolve('apps/host/resources/bin/agentmux-workspace-move')
  vi.stubEnv('AGENTMUX_WORKSPACE_MOVE_HELPER', helper)
  const sources = []
  for (const id of ['source-a', 'source-b']) {
    const directory = join(root, id), state = join(directory, 'state'), runtimeDirectory = join(directory, 'runtime')
    const project = options.sharedProject ? join(root, 'shared-project') : join(directory, 'project')
    await Promise.all([mkdir(state, { recursive: true }), mkdir(runtimeDirectory, { recursive: true }), mkdir(project, { recursive: true })])
    // The original Notes owner has a separate locator; state/runtime isolation alone
    // must never let this fixture borrow the user's default Notes directory.
    await mkdir(join(directory, 'notes'), { recursive: true })
    await writeFile(join(state, 'notes-location.json'), JSON.stringify({ schemaVersion: 1, directory: join(directory, 'notes'), operations: {}, pending: null }))
    const daemon = spawn(resolve('packages/core/vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd'),
      ['--socket', join(runtimeDirectory, 'ctxmux.sock'), '--state-dir', join(state, 'ctxmux'), '--readiness-fd', '3'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
    cleanup.push(async () => { if (daemon.exitCode === null && daemon.signalCode === null) { const done = once(daemon, 'exit'); daemon.kill('SIGTERM'); await done } })
    await new Promise<void>((yes, no) => {
      const timer = setTimeout(() => no(new Error('Private Source Native readiness unavailable')), 15_000)
      daemon.stdio[3]!.once('data', () => { clearTimeout(timer); yes() })
      daemon.once('error', error => { clearTimeout(timer); no(error) })
      daemon.once('exit', code => { clearTimeout(timer); no(new Error('Private Source Native exited ' + code)) })
    })
    vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', runtimeDirectory); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', state)
    vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(state, 'messages.ndjson'))
    vi.stubEnv('AGENTMUX_SPATIAL_STATE_STORE', join(state, 'spatial.json'))
    const store = new AgentMuxFileAgentSessionStore(join(state, 'sessions.json')), configurationPath = join(directory, 'config.json')
    const scratch = join(directory, 'scratch')
    if (options.scratch) await mkdir(scratch)
    await writeFile(configurationPath, JSON.stringify({ hosts: [{ id: 'local', kind: 'local', label: id }],
      workspaces: [{ id: 'same-workspace', hostId: 'local', path: project, name: id },
        ...(options.scratch ? [{ id: '__scratch__', hostId: 'local', path: scratch, name: 'Original scratch' }] : [])], executors: {}, appearance: {} }))
    await writeFile(join(project, 'original.txt'), id + ' original body')
    const socketPath = join(runtimeDirectory, 'control.sock')
    const host = await startAgentMuxHost({ store, configurationPath, socketPath,
      desktopSocketPath: join(directory, 'absent-desktop.sock'), mobileBuildDirectory: join(directory, 'absent-mobile') })
    cleanup.push(() => host.dispose())
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }); cleanup.push(() => rpc.dispose())
    const identity = (await rpc.call('runtime.owner.identity', {})).owner
    const connect = configuredDesktopAgentMuxHost(configurationPath, join(state, 'connectors'))
    const client = await connect({ id: 'local', kind: 'local', label: id }, store); cleanup.push(() => client.dispose())
    sources.push({ id, directory, state, project, scratch, socketPath, store, host, rpc, identity, client, configurationPath })
  }
  const routes = new Map(sources.map(source => [source.id, { client: source.client }]))
  const runtime = Object.assign(Object.create(RuntimeController.prototype), { hosts: routes, hostReconfigurationReservations: new Map() }) as RuntimeController
  return { root, sources, routes, runtime }
}
