import { mintObjectId } from '@agentmux/core/object-id'
import type { WorktreeCloseoutParams, WorktreeCloseoutReceipt } from '@agentmux/core'
import type { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import type { WorkspaceRecord, RemoveWorktreeInput, RemoveWorktreeOutcome, KeepOneOfFanOutInput, KeepOneOfFanOutOutcome, WorktreeRetention } from '../shared/contracts.js'
import { closeWorktreeGraph, closeoutDestination } from '../shared/worktree-closeout.js'
import { classifyRetention, type WorktreeService } from './worktree-service.js'
import type { ConfigOwner } from './config-owner.js'

/** Compose the original resource, spatial and Runtime owners; never launch or stop a Run. */
export class WorktreeCloseoutOwner {
  private readonly flights = new Map<string, { operationId: string; discardChanges: boolean | undefined; promise: Promise<RemoveWorktreeOutcome> }>()
  constructor(private readonly ports: {
    config: Pick<ConfigOwner, 'current' | 'edit' | 'update'>
    spatial: Pick<AgentMuxSpatialStateStore, 'read' | 'commit'>
    worktrees: Pick<WorktreeService, 'removeWorktree' | 'isRegistered' | 'directoryPresent'>
    prepare(): Promise<void>
    /** Includes retained recoverable Sessions, not merely live processes. */
    executionReferences(workspace: WorkspaceRecord): Promise<string[]>
  }) {}

  close(input: RemoveWorktreeInput & { expectedResource?: WorktreeCloseoutParams['expectedResource'] }, operationId: string): Promise<RemoveWorktreeOutcome> {
    const original = this.flights.get(input.workspaceId)
    if (original) {
      if (original.operationId !== operationId || original.discardChanges !== input.discardChanges) {
        return Promise.resolve({ status: 'retained', retention: 'git-failed', reason: 'Another exact closeout operation is still running. Inspect its original receipt before a new cleanup operation.' })
      }
      return original.promise
    }
    const flight = this.perform(input, operationId).finally(() => {
      if (this.flights.get(input.workspaceId)?.promise === flight) this.flights.delete(input.workspaceId)
    })
    this.flights.set(input.workspaceId, { operationId, discardChanges: input.discardChanges, promise: flight })
    return flight
  }

  async publicClose(input: WorktreeCloseoutParams): Promise<WorktreeCloseoutReceipt> {
    const prior = (await this.ports.spatial.read())?.graph.resources['worktree-closeout:' + input.operationId]
    if (prior && typeof prior === 'object' && !Array.isArray(prior)) {
      const params = prior.params as unknown as WorktreeCloseoutParams
      if (params.workspaceId !== input.workspaceId || params.operationId !== input.operationId ||
        params.expectedResource.hostId !== input.expectedResource.hostId || params.expectedResource.workspacePath !== input.expectedResource.workspacePath ||
        params.discardChanges !== input.discardChanges) throw new Error('The original closeout operation belongs to different input. Keep its original identity and receipt.')
      return prior.receipt as unknown as WorktreeCloseoutReceipt
    }
    const source = this.ports.config.current.workspaces.find(workspace => workspace.id === input.workspaceId)
    if (!source || source.hostId !== input.expectedResource.hostId || source.path !== input.expectedResource.workspacePath) {
      throw new Error('The exact worktree resource changed. Inspect its original Host and directory before closing it.')
    }
    const result = await this.close(input, input.operationId)
    if (result.status !== 'closed') throw new Error(result.status === 'retained' ? result.reason : 'The original closeout receipt is unavailable.')
    return result.closeout
  }

  async keepOne(input: KeepOneOfFanOutInput): Promise<KeepOneOfFanOutOutcome> {
    if (!this.ports.config.current.workspaces.some(workspace => workspace.id === input.keepWorkspaceId && !workspace.closeout)) {
      throw new Error('The selected worktree is unavailable. All original worktrees are retained.')
    }
    const outcomes: KeepOneOfFanOutOutcome['outcomes'] = []
    for (const workspaceId of new Set(input.removeWorkspaceIds)) {
      if (workspaceId === input.keepWorkspaceId) continue
      const result = await this.close({ workspaceId }, mintObjectId())
      if (result.status === 'closed') outcomes.push({ status: 'closed', workspaceId, closeout: result.closeout })
      else if (result.status === 'removed') outcomes.push({ status: 'removed', workspaceId, removedPath: result.removedPath })
      else outcomes.push({ ...result, workspaceId })
    }
    return { keptWorkspaceId: input.keepWorkspaceId, outcomes }
  }

  private async perform(input: RemoveWorktreeInput & { expectedResource?: WorktreeCloseoutParams['expectedResource'] }, operationId: string): Promise<RemoveWorktreeOutcome> {
    let config = this.ports.config.current
    const source = config.workspaces.find(workspace => workspace.id === input.workspaceId)
    if (!source || source.kind !== 'worktree' || !source.repoPath) {
      return { status: 'retained', retention: 'git-failed', reason: 'An exact worktree Workspace is required. Other workfaces are retained.' }
    }
    const assertSource = (current: typeof config) => {
      const actual = current.workspaces.find(workspace => workspace.id === source.id)
      if (!actual || actual.hostId !== source.hostId || actual.path !== source.path || actual.repoPath !== source.repoPath || actual.kind !== source.kind ||
        input.expectedResource && (source.hostId !== input.expectedResource.hostId || source.path !== input.expectedResource.workspacePath)) {
        throw new Error('The original worktree resource changed during closeout. No directory was removed; inspect its exact original resource before another operation.')
      }
    }
    let workface: 'moved' | 'pending' = 'pending'
    let movedTabIds: string[] = []
    try {
      await this.ports.prepare()
      assertSource(this.ports.config.current)
      const started = await this.ports.spatial.read()
      if (!started) throw new Error('The original spatial document is unavailable. Original workfaces and directories are retained.')
      const startedZones = new Set(started.graph.zones.filter(zone => zone.workspaceId === source.id).map(zone => zone.zoneId))
      const startedTabs = started.graph.tabs.filter(tab => tab.workspaceId === source.id || startedZones.has(tab.zoneId ?? '')).map(tab => tab.tabId)
      let target = source.closeout ? config.workspaces.find(workspace => workspace.id === source.closeout!.targetWorkspaceId && !workspace.closeout)
        : closeoutDestination(config.workspaces, source)
      if (!target && !source.closeout) {
        target = { id: mintObjectId(), name: source.repoPath.split(/[\\/]/).filter(Boolean).at(-1) ?? source.name,
          hostId: source.hostId, path: source.repoPath, repoPath: source.repoPath, kind: 'folder' }
        config = await this.ports.config.edit(config, { ...config, workspaces: [...config.workspaces, target] })
      }
      if (!target || target.hostId !== source.hostId || target.path !== source.repoPath) {
        throw new Error('The original default workspace is unavailable. Restore its exact resource; the workface and directory are retained.')
      }
      // The original record is also the recoverable cleanup responsibility. Persist it
      // before Git can remove anything; config publication rehomes pending local layouts.
      if (!source.closeout) {
        config = await this.ports.config.update(actual => {
          assertSource(actual)
          const destination = actual.workspaces.find(workspace => workspace.id === target!.id)
          if (!destination || destination.closeout || destination.hostId !== target!.hostId || destination.path !== target!.path) throw new Error('The original default workspace changed during closeout. Both workfaces and directories are retained.')
          return { ...actual, workspaces: actual.workspaces.map(workspace => workspace.id === source.id
            ? { ...workspace, closeout: { targetWorkspaceId: target!.id, operationId, cleanup: 'pending' as const,
              reason: 'Workface closing; original resources remain until cleanup is confirmed.' } } : workspace) }
        })
      }
      // Config publication reaches the original Renderer before this barrier.
      // Drain its closeout projection, preserving drafts and avoiding a competing
      // old-layout save while Main records the same operation's durable result.
      await this.ports.prepare()
      assertSource(this.ports.config.current)
      const current = await this.ports.spatial.read()
      if (!current) throw new Error('The original spatial document is unavailable. The directory and cleanup responsibility are retained.')
      const move = closeWorktreeGraph(current.graph, source, target)
      movedTabIds = [...new Set([...move.movedTabIds, ...startedTabs.filter(id => move.graph.tabs.some(tab => tab.tabId === id && tab.workspaceId === target!.id))])]
      const receipt = (cleanup: 'pending' | 'removed' | 'kept', reason: string | null): WorktreeCloseoutReceipt => ({
        workspaceId: source.id, targetWorkspaceId: target!.id, movedTabIds, workface, cleanup, reason })
      const params: WorktreeCloseoutParams = { workspaceId: source.id,
        expectedResource: { hostId: source.hostId, workspacePath: source.path }, operationId,
        ...(input.discardChanges === undefined ? {} : { discardChanges: input.discardChanges }) }
      const remember = async (result: WorktreeCloseoutReceipt): Promise<void> => {
        const latest = await this.ports.spatial.read()
        if (!latest) throw new Error('The original spatial receipt owner is unavailable.')
        const graph = structuredClone(latest.graph)
        graph.resources['worktree-closeout:' + operationId] = JSON.parse(JSON.stringify({ params, receipt: result }))
        await this.ports.spatial.commit({ expectedRevision: latest.revision, graph })
      }
      workface = 'moved'
      move.graph.resources['worktree-closeout:' + operationId] = JSON.parse(JSON.stringify({ params,
        receipt: receipt('pending', 'Workface is closed; directory cleanup has not been confirmed. Inspect the original directory before a new cleanup operation.') }))
      try { await this.ports.spatial.commit({ expectedRevision: current.revision, graph: move.graph, allowEntityRemoval: true }) }
      catch (error) { workface = 'pending'; throw error }
      let reason: string | null = null
      let retention: WorktreeRetention | undefined
      try {
        const references = await this.ports.executionReferences(source)
        if (references.length) reason = 'Original Agents or terminals still need this directory. Continue working, or close those resources before retrying cleanup.'
      } catch (error) { reason = 'Runtime cleanup eligibility is unconfirmed. Original directory retained: ' + errorText(error) }
      const files = current.graph.regions.filter(region => ['file', 'git', 'git-diff'].includes(region.kind)).filter(region => {
        const resource = current.graph.resources['region:' + region.regionId]
        return resource && typeof resource === 'object' && !Array.isArray(resource) && resource.workspaceId === source.id
      })
      if (files.length) reason = 'Original file workfaces still use this directory. Save and close them before retrying cleanup.'
      let registered = true
      try { registered = await this.ports.worktrees.isRegistered(source) }
      catch (error) { reason ??= 'Git registration is unconfirmed. Original directory retained: ' + errorText(error) }
      // An unregistered path can hold hooks, evidence or unrelated user data. Its
      // existence is not a new deletion authorization; closing its display is enough.
      const keepDirectory = !registered && await this.ports.worktrees.directoryPresent(source)
      if (!reason) {
        let removed = false
        try {
          assertSource(this.ports.config.current)
          const removal = !registered ? { config: await this.ports.config.update(actual => {
            assertSource(actual)
            return { ...actual, workspaces: actual.workspaces.filter(workspace => workspace.id !== source.id) }
          }) } : await this.ports.worktrees.removeWorktree(input, this.ports.config.current)
          removed = true
          const result = receipt(keepDirectory ? 'kept' : 'removed', keepDirectory ? 'Git already ended this worktree. Remaining files and evidence are kept in the original directory.' : null)
          await remember(result)
          return { status: 'closed', config: removal.config, closeout: result }
        } catch (error) {
          if (removed) {
            reason = (keepDirectory ? 'The remaining directory was kept, but its final cleanup result could not be saved. '
              : 'Git confirmed directory removal, but its final result could not be saved. ') + 'The original cleanup record is retained for inspection and retry. ' + errorText(error)
            retention = keepDirectory ? 'git-failed' : 'record-not-withdrawn'
            config = this.ports.config.current
            if (!config.workspaces.some(workspace => workspace.id === source.id)) {
              config = await this.ports.config.edit(config, { ...config, workspaces: [...config.workspaces, { ...source,
                closeout: { targetWorkspaceId: target.id, operationId, cleanup: 'pending', reason, retention } }] })
            }
          } else { const failure = classifyRetention(error); reason = failure.reason; retention = failure.retention }
        }
      }
      config = this.ports.config.current
      config = await this.ports.config.edit(config, { ...config, workspaces: config.workspaces.map(workspace => workspace.id === source.id
        ? { ...workspace, closeout: { targetWorkspaceId: target!.id, operationId: source.closeout?.operationId ?? operationId,
          cleanup: 'pending' as const, reason: reason!, ...(retention ? { retention } : {}) } } : workspace) })
      const result = receipt('pending', reason)
      await remember(result)
      return { status: 'closed', config, closeout: result }
    } catch (error) {
      const retained = this.ports.config.current.workspaces.find(workspace => workspace.id === source.id)?.closeout
      if (retained) {
        const reason = 'Closeout is incomplete; the original directory and cleanup responsibility are retained. ' + errorText(error)
        try { await this.ports.config.update(actual => ({ ...actual, workspaces: actual.workspaces.map(workspace => workspace.id === source.id && workspace.closeout
          ? { ...workspace, closeout: { ...workspace.closeout, reason } } : workspace) })) } catch { /* The original durable cleanup record remains authoritative. */ }
        return { status: 'closed', config: this.ports.config.current, closeout: {
        workspaceId: source.id, targetWorkspaceId: retained.targetWorkspaceId, movedTabIds,
        workface, cleanup: 'pending', reason } }
      }
      return { status: 'retained', ...classifyRetention(error) }
    }
  }
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }
