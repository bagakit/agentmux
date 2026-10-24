import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AgentMuxSpaceCatalog, FileReadParams } from '@agentmux/core'
import { captureGoalFileEvidence } from '@agentmux/core/goal-evidence'
import { FileReadOwner } from '@agentmux/host/file-read-owner'
import { WorkspaceFiles } from '../../src/main/workspace-files'
import type { WorkspaceRecord } from '../../src/shared/contracts'

export async function goalEvidenceSource() {
  const root = await mkdtemp(join(tmpdir(), 'goal-source-'))
  const workspaces: WorkspaceRecord[] = ['main', 'worktree'].map(id => ({ id, name: id === 'main' ? 'Project' : 'Project worktree', hostId: 'source-host', path: join(root, id), kind: 'folder' }))
  for (const workspace of workspaces) { await mkdir(workspace.path); await writeFile(join(workspace.path, 'result.log'), workspace.id === 'main' ? 'WRONG main evidence' : 'ORIGINAL worktree evidence') }
  const zones = workspaces.map(workspace => ({ zoneId: workspace.id + '-zone', workspaceId: workspace.id, hostId: workspace.hostId, directoryPath: workspace.path, kind: 'directory' }))
  const catalog = { zones, bindings: [] } as unknown as AgentMuxSpaceCatalog
  const host = { id: 'source-host', kind: 'local' as const, label: 'Test Host', run: async () => { throw new Error('Unexpected host command') }, exposeLoopbackPort: async (port: number) => port, dispose: async () => {} }
  const files = new WorkspaceFiles(() => host)
  const owner = new FileReadOwner({ catalog: async () => catalog, workspace: id => workspaces.find(workspace => workspace.id === id), files })
  const source = workspaces[1]!, target: FileReadParams = { zoneId: zones[1]!.zoneId, path: 'result.log', expectedResource: { hostId: source.hostId, workspaceId: source.id, workspacePath: source.path } }
  const observed = await owner.read(target), evidence = captureGoalFileEvidence(target, observed, { line: 2 })
  return { root, workspaces, catalog, owner, files, target, evidence,
    dispose: async () => { await files.dispose(); await rm(root, { recursive: true, force: true }) } }
}
