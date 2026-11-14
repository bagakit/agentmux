import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { expect, vi } from 'vitest'
import * as core from '@agentmux/core'
import { startAgentMuxHost } from '../../src/host.js'
import { FilePathMutations } from '../../src/file-path-mutations.js'
import { OrdinaryWorkspaceFiles } from '../../src/ordinary-files.js'
import { rpcOwnerFixture } from '../../../../packages/core/test/helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../../packages/core/test/helpers/object-cli-rpc.js'
import type { FileMkdirParams, FileMutationInspectParams } from '@agentmux/core/files'

export const cleanup: Array<() => unknown | Promise<unknown>> = []
export const helper = resolve('apps/host/resources/bin/agentmux-workspace-move')
export const agent = { actor: { kind: 'agent' as const, id: 'original-files-agent' }, callerHostId: 'local' }
export const operationDirectory = (root: string, operationId: string) => join(root, 'file-path-mutations', createHash('sha256').update(operationId).digest('hex'))
export const operationRecord = (root: string, operationId: string) => join(operationDirectory(root, operationId), 'request.json')

export async function fixture(options: ConstructorParameters<typeof OrdinaryWorkspaceFiles>[0] = {}) {
  const original = await rpcOwnerFixture([agent.actor.id, 'other-files-agent'], core); cleanup.push(original.close)
  const root = join(original.root, 'workspace'); await mkdir(root)
  const workspace = { id: 'original-files', hostId: 'local', path: root, name: 'Original files' }
  const ordinary = new OrdinaryWorkspaceFiles({ helperPath: helper, ...options })
  const owner = new FilePathMutations({ directory: join(original.root, 'file-path-mutations'), files: ordinary, noteLease: work => work() })
  const descriptor = (path: string) => ({ hostId: 'local', workspaceId: workspace.id, workspacePath: root, zoneId: 'original-files-zone', zonePath: root, path })
  const request = async (path: string, operationId: string): Promise<FileMkdirParams> => {
    const observed = await owner.stat(workspace, path)
    return { zoneId: 'original-files-zone', path, expectedResource: descriptor(path), operationId, expectedAbsent: true, expected: { root: observed.root, parent: observed.parent } }
  }
  const inspect = (input: FileMkdirParams): FileMutationInspectParams => ({ zoneId: input.zoneId, path: input.path, operationId: input.operationId, expectedResource: input.expectedResource })
  return { original, root, workspace, ordinary, owner, descriptor, request, inspect }
}

export async function hostFixture(physicalName?: string) {
  const f = await fixture()
  if (physicalName) { const root = join(f.original.root, physicalName); await rename(f.root, root); f.root = root; f.workspace.path = root }
  const spatial = new core.AgentMuxSpatialStateStore()
  const notes = join(f.original.root, 'private-notes'); await mkdir(notes); await mkdir(join(f.original.root, 'state'), { recursive: true })
  await writeFile(join(f.original.root, 'state/notes-location.json'), JSON.stringify({ schemaVersion: 1, directory: notes, operations: {}, pending: null }))
  await spatial.commit({ expectedRevision: 0, graph: {
    spaces: [{ spaceId: 'original-files-space', kind: 'folder', name: 'Private Files', hostId: 'local', directoryPath: f.root, projectId: 'original-files-space' }],
    zones: [{ zoneId: 'original-files-zone', workspaceId: f.workspace.id, kind: 'directory', hostId: 'local', directoryPath: f.root, branch: null }],
    bindings: [{ spaceId: 'original-files-space', zoneId: 'original-files-zone' }], tabs: [], regions: [], layouts: {}, tabLayouts: {}, resources: {}
  } })
  const configurationPath = join(f.original.root, 'configuration.json')
  await writeFile(configurationPath, JSON.stringify({ hosts: [{ id: 'local', kind: 'local', label: 'Private' }], workspaces: [f.workspace] }))
  const native = f.original.inner.kernel; await f.original.client.dispose()
  const connect = vi.spyOn(core.AgentMuxClient.prototype, 'connect').mockImplementationOnce(async function () {
    const inner = this as unknown as typeof f.original.inner
    await inner.registry.load('local'); inner.connected = true
    for (const name of ['isConnected', 'status', 'identity', 'input', 'observeOutput', 'attach', 'detach', 'stop']) inner.kernel[name] = native[name]
    inner.kernel.listPage = async () => ({ runs: [], nextCursor: null })
  })
  const socketPath = join(f.original.root, 'host.sock')
  let host: Awaited<ReturnType<typeof startAgentMuxHost>>
  try {
    host = await startAgentMuxHost({ store: f.original.store, configurationPath, socketPath, desktopSocketPath: join(f.original.root, 'absent-desktop.sock'), mobileBuildDirectory: join(f.original.root, 'absent-mobile') })
    cleanup.push(() => host.dispose())
    await vi.waitFor(() => expect((host.client as unknown as typeof f.original.inner).connected).toBe(true))
  } finally { connect.mockRestore() }
  const env = objectCliEnvironment(f.original.root, { AGENTMUX_AGENT_SESSION_ID: agent.actor.id, AGENTMUX_AGENT_CAPABILITY: f.original.capability })
  const cli = async (action: string[], input: unknown, who = agent.actor.id) => {
    const result = await runCompiledObjectCli(['--endpoint', 'unix:' + socketPath, 'file', ...action, '--input', '-'],
      { ...env, AGENTMUX_AGENT_SESSION_ID: who }, JSON.stringify(input))
    return { ...result, body: result.stdout ? JSON.parse(result.stdout) : undefined }
  }
  return { ...f, host, cli, spatial, configurationPath }
}

