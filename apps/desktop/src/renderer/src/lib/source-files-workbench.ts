import { mintObjectId } from '@agentmux/core/object-id'
import { parseFileDeleteParams, parseFileMkdirParams, parseFileMoveParams, type FileMutationEffect } from '@agentmux/core/files'
import type { FolderDirectoryRegistration } from '@agentmux/core/space-folder'
import type { SpaceMountSourceTarget } from '../../../shared/space-mount'
import type { SourceFilesLocator, SourceFilesResolution } from '../../../shared/source-files'
import type { SourceFilesApi } from '../../../shared/source-files-client'
import type { WorkspaceRecord } from '../../../shared/contracts'

type Mutation = { action: 'mkdir'; request: import('@agentmux/core/files').FileMkdirParams }
  | { action: 'move'; request: import('@agentmux/core/files').FileMoveParams }
  | { action: 'delete'; request: import('@agentmux/core/files').FileDeleteParams }
/** User selections and complete original requests, not a second Source catalog. */
export type SourceFilesInput = {
  workspace: Pick<WorkspaceRecord, 'id' | 'hostId' | 'path'>
  target: SpaceMountSourceTarget
  selection: import('../../../shared/source-files').SourceFilesSelection
  registration?: FolderDirectoryRegistration | undefined
  registrationStatus?: 'pending' | 'confirmed' | 'unknown'
  locator?: SourceFilesLocator | undefined
  issue?: string | undefined
}
export type SourceFilesPending = Mutation & { target: SpaceMountSourceTarget; workspace: SourceFilesInput['workspace']; observed?: FileMutationEffect; issue?: string | undefined }
export type SourceFileCreation = { workspace: SourceFilesInput['workspace']; target: SpaceMountSourceTarget; request: import('@agentmux/core/files').FileCreateParams; issue?: string }
export type SourceFolderRequest = { workspace: SourceFilesInput['workspace']; target: SpaceMountSourceTarget; packet: FolderDirectoryRegistration; issue?: string }
export type SourceFilesInputs = { selections: Record<string, SourceFilesInput>; pending: Record<string, SourceFilesPending>; creations: Record<string, SourceFileCreation>; folderRequests: Record<string, SourceFolderRequest> }
export const emptySourceFilesInputs = (): SourceFilesInputs => ({ selections: {}, pending: {}, creations: {}, folderRequests: {} })
function mutationConfirmed(receipt: import('@agentmux/core/files').FilePathMutationReceipt | import('@agentmux/core/files').FileMoveReceipt | import('@agentmux/core/files').FileDeleteReceipt): boolean {
  return receipt.durability === 'confirmed' && receipt.filesystem !== 'unknown' &&
    (!('noteMetadata' in receipt) || receipt.noteMetadata?.status !== 'unconfirmed') &&
    (!('noteHistory' in receipt) || receipt.noteHistory?.status !== 'unconfirmed') &&
    (!('nameAudit' in receipt) || receipt.nameAudit?.status !== 'unconfirmed')
}
export const sourceFilesWorkspaceMatches = (left: SourceFilesInput['workspace'], right: SourceFilesInput['workspace'] | undefined) =>
  Boolean(right && left.id === right.id && left.hostId === right.hostId && left.path === right.path)
export function sourceFilesQuery(locator: SourceFilesLocator, path: string) {
  return { zoneId: locator.resource.zoneId, path: path || '.', expectedResource: {
    hostId: locator.resource.hostId, workspaceId: locator.resource.workspaceId, workspacePath: locator.resource.workspacePath
  } }
}
/** A live Zone may change independently; its later path cannot replace the selected mapping. */
export function sourceFilesMappingMatches(locator: SourceFilesLocator, resource: import('@agentmux/core/files').FileReadResource, path: string): boolean {
  const base = locator.resource.path === '.' ? '' : locator.resource.path
  const expected = !path || path === '.' ? base : base ? base + '/' + path : path
  return ['hostId', 'workspaceId', 'workspacePath', 'zoneId', 'zonePath', 'logicalDirectory'].every(key =>
    resource[key as keyof typeof resource] === locator.resource[key as keyof typeof resource]) && (resource.path === '.' ? '' : resource.path) === expected
}

/** The existing UserState owns custody; every effect uses the original typed Source port. */
export function createSourceFilesWorkbench(ports: {
  api: SourceFilesApi
  get(): SourceFilesInputs
  set(update: (current: SourceFilesInputs) => SourceFilesInputs): void
  workspace(id: string): SourceFilesInput['workspace'] | undefined
  checkpoint(): Promise<void>
  runtime(hostId: string): Promise<string>
  register(hostId: string, packet: FolderDirectoryRegistration): Promise<import('@agentmux/core/space-folder').FolderSpaceReceipt>
  prepareEffect(workspaceId: string, locator: SourceFilesLocator): (effect: FileMutationEffect) => Promise<void>
}) {
  const current = (input: SourceFilesInput) => sourceFilesWorkspaceMatches(input.workspace, ports.workspace(input.workspace.id)) && ports.get().selections[input.workspace.id] === input
  const replace = (input: SourceFilesInput, next: SourceFilesInput) => ports.set(state => state.selections[input.workspace.id] !== input ? state : {
    ...state, selections: { ...state.selections, [input.workspace.id]: next }
  })
  const resolve = async (workspaceId: string): Promise<SourceFilesResolution> => {
    const workspace = ports.workspace(workspaceId)
    if (!workspace) throw new Error('The original display Workspace is unavailable. Its buffers and requests are retained.')
    let input = ports.get().selections[workspaceId]
    if (!input) {
      const baseline = structuredClone(workspace), runtimeId = await ports.runtime(workspace.hostId)
      if (!sourceFilesWorkspaceMatches(baseline, ports.workspace(workspaceId))) throw new Error('The directory selection changed while observing its Source.')
      // Another explicit selection may have won while discovery awaited.
      input = ports.get().selections[workspaceId]
      if (!input) {
        input = { workspace: baseline, target: { hostId: baseline.hostId, expectedRuntimeId: runtimeId }, selection: { kind: 'directory', path: baseline.path } }
        const chosen = input
        ports.set(state => ({ ...state, selections: { ...state.selections, [workspaceId]: chosen } }))
      }
    }
    if (!current(input)) return { status: 'unconfirmed', issue: { code: 'SOURCE_FILES_SELECTION_CHANGED', message: 'Restore the original directory selection to check its retained requests.' } }
    const selection = input.registration ? { kind: 'directory' as const, path: input.registration.directory.workspacePath,
      expectedResource: input.registration.directory, ...(input.selection.kind === 'directory' && input.selection.registration ? { registration: input.selection.registration } : {}) } : input.selection
    const result = await ports.api.resolve(input.target, selection)
    if (!current(input)) return { status: 'unconfirmed', issue: { code: 'SOURCE_FILES_SELECTION_CHANGED', message: 'Later directory selection was retained; the old observation was not adopted.' } }
    replace(input, { ...input, ...(result.status === 'located' ? { locator: result.locator, issue: undefined } : { locator: undefined,
      issue: result.status === 'unconfirmed' ? result.issue.message : result.status === 'selection-required' ? 'Choose the original Source registration before changing files.' : undefined }) })
    return result
  }
  const useFolder = async (workspaceId: string, packet: FolderDirectoryRegistration) => {
    const input = ports.get().selections[workspaceId]
    if (!input || !current(input)) throw new Error('The original directory selection changed. Its request was retained.')
    if (input.registration) return await resolve(workspaceId) // Unknown is reconciled read-only, never registered twice.
    if (packet.runtimeId !== ('reference' in input.target ? input.target.reference.runtimeId : input.target.expectedRuntimeId) ||
        packet.directory.workspacePath !== input.workspace.path) throw new Error('Use the complete packet observed for this exact original directory and Source.')
    const retained: SourceFilesInput = { ...input, registration: structuredClone(packet), registrationStatus: 'pending' }
    replace(input, retained)
    await ports.checkpoint()
    if (!current(retained)) throw new Error('The original directory request was saved; later selection was preserved. No registration was sent.')
    try {
      const receipt = await ports.register(retained.workspace.hostId, retained.registration!)
      if (current(retained)) replace(retained, { ...retained, registrationStatus: 'confirmed', selection: { kind: 'directory', path: retained.workspace.path,
        expectedResource: retained.registration!.directory, registration: { hostId: retained.workspace.hostId, reference: receipt.reference, zoneId: receipt.zoneId, workspaceId: receipt.workspaceId } } })
    } catch (cause) {
      replace(retained, { ...retained, registrationStatus: 'unknown', issue: 'The original registration outcome is unconfirmed. Check this saved directory request; do not repeat it.' })
      throw cause
    }
    return await resolve(workspaceId)
  }
  const locator = (workspaceId: string) => {
    const input = ports.get().selections[workspaceId]
    if (!input || !current(input) || !input.locator) throw new Error('Use the original Source folder in Files before changing this directory. Existing editors remain available.')
    return input
  }
  const stat = async (input: SourceFilesInput, path: string, revision = false) => {
    const result = (await ports.api.call(input.target, 'file.stat', { ...sourceFilesQuery(input.locator!, path), ...(revision ? { includeRevision: true } : {}) })).result
    if (!current(input) || !result.resource || result.result.status !== 'observed' || !sourceFilesMappingMatches(input.locator!, result.resource, path)) throw new Error('The exact original file generation or Source mapping is unconfirmed. No mutation was sent.')
    return { resource: result.resource, observation: result.result.observation }
  }
  const dispatch = async (workspaceId: string, mutation: Mutation) => {
    const input = locator(workspaceId), operationId = mutation.request.operationId
    if (Object.values(ports.get().pending).some(item => item.workspace.id === workspaceId && item.action === mutation.action)) throw new Error('Check the retained original request before repeating this action.')
    const pending: SourceFilesPending = structuredClone({ ...mutation, workspace: input.workspace, target: input.target })
    ports.set(state => ({ ...state, pending: { ...state.pending, [operationId]: pending } }))
    const consumeEffect = ports.prepareEffect(workspaceId, input.locator!)
    await ports.checkpoint()
    if (!current(input) || ports.get().pending[operationId] !== pending) throw new Error('The original request was saved. Later selection was preserved; no mutation was sent.')
    let ownedPending = pending
    const saved = (next?: SourceFilesPending) => {
      ports.set(state => state.pending[operationId] !== ownedPending ? state : { ...state, pending: Object.fromEntries([
        ...Object.entries(state.pending).filter(([id]) => id !== operationId), ...(next ? [[operationId, next] as const] : [])
      ]) })
      if (next) ownedPending = next
    }
    try {
      // Each branch retains the exact original typed request and effect receipt.
      let effect: FileMutationEffect
      if (mutation.action === 'mkdir') effect = { type: 'path-mutation', action: 'mkdir', request: mutation.request,
        receipt: (await ports.api.call(input.target, 'file.mkdir', mutation.request)).result }
      else if (mutation.action === 'move') effect = { type: 'path-mutation', action: 'move', request: mutation.request,
        receipt: (await ports.api.call(input.target, 'file.move', mutation.request)).result }
      else effect = { type: 'path-mutation', action: 'delete', request: mutation.request,
        receipt: (await ports.api.call(input.target, 'file.delete', mutation.request)).result }
      const receipt = effect.receipt.result
      saved({ ...pending, observed: effect })
      if (receipt.filesystem === 'created' || receipt.filesystem === 'moved' || receipt.filesystem === 'deleted') await consumeEffect(effect)
      if (mutationConfirmed(receipt)) saved()
      else saved({ ...ownedPending, issue: receipt.message ?? 'The original outcome is unconfirmed. Check the saved operation without resending it.' })
      await ports.checkpoint()
      if (receipt.filesystem === 'unknown' || receipt.filesystem === 'not-applied') throw new Error(receipt.message ?? 'The original file mutation was not confirmed.')
    } catch (cause) { saved({ ...ownedPending, issue: cause instanceof Error ? cause.message : String(cause) }); throw cause }
  }
  return {
    resolve, useFolder,
    async selectCurrentSource(workspaceId: string) {
      const original = ports.get().selections[workspaceId], workspace = ports.workspace(workspaceId)
      if (!workspace) throw new Error('The current display directory is unavailable. Original requests are retained.')
      const baseline = structuredClone(workspace), runtimeId = await ports.runtime(workspace.hostId)
      if (!sourceFilesWorkspaceMatches(baseline, ports.workspace(workspaceId)) || ports.get().selections[workspaceId] !== original) throw new Error('The directory selection changed while observing its Source. No new Source was selected.')
      const retained = original?.registration && original.registrationStatus !== 'confirmed'
        ? { workspace: original.workspace, target: original.target, packet: original.registration } : undefined
      const key = mintObjectId(), selected: SourceFilesInput = { workspace: baseline, target: { hostId: baseline.hostId, expectedRuntimeId: runtimeId },
        selection: { kind: 'directory', path: baseline.path } }
      ports.set(state => ({ ...state, selections: { ...state.selections, [workspaceId]: selected },
        folderRequests: retained ? { ...state.folderRequests, [key]: retained } : state.folderRequests }))
      await ports.checkpoint()
      return await resolve(workspaceId)
    },
    async selectRegistration(workspaceId: string, registration: import('../../../shared/space-mount').SpaceMountRecord) {
      const input = ports.get().selections[workspaceId]
      if (!input || !current(input)) throw new Error('The original directory selection is no longer current.')
      const selection = { kind: 'directory' as const, path: input.workspace.path, registration: structuredClone(registration),
        ...(input.registration ? { expectedResource: input.registration.directory } : {}) }
      const result = await ports.api.resolve(input.target, selection)
      if (!current(input)) throw new Error('Later Source selection was preserved. The old registration was not adopted.')
      if (result.status !== 'located') return result
      replace(input, { ...input, selection, locator: result.locator })
      await ports.checkpoint()
      return result
    },
    async inspectFolderRequest(key: string) {
      const held = ports.get().folderRequests[key]
      if (!held) return
      const result = await ports.api.resolve(held.target, { kind: 'directory', path: held.packet.directory.workspacePath, expectedResource: held.packet.directory })
      ports.set(state => state.folderRequests[key] !== held ? state : { ...state, folderRequests: { ...state.folderRequests, [key]: { ...held,
        issue: `Current discovery: ${result.status}. The original registration reply remains unconfirmed; the saved request was not repeated.` } } })
      await ports.checkpoint()
      return result
    },
    async createFile(workspaceId: string, path: string) {
      const input = locator(workspaceId), observed = await stat(input, path)
      const request: import('@agentmux/core/files').FileCreateParams = { ...sourceFilesQuery(input.locator!, path), expectedResource: observed.resource, content: '', expectedRevision: null }
      if (Object.values(ports.get().creations).some(item => item.workspace.id === workspaceId && item.request.path === path)) throw new Error('The original file creation is retained. Check that exact file without creating it again.')
      const key = mintObjectId(), retained = structuredClone({ workspace: input.workspace, target: input.target, request })
      ports.set(state => ({ ...state, creations: { ...state.creations, [key]: retained } }))
      const consume = ports.prepareEffect(workspaceId, input.locator!)
      await ports.checkpoint()
      if (!current(input) || ports.get().creations[key] !== retained) throw new Error('The original file creation was saved. Later selection was preserved; no creation was sent.')
      const response = (await ports.api.call(input.target, 'file.create', request)).result
      if (response.result.status === 'written' && response.resource) {
        await consume({ type: 'created-file', resource: response.resource, revision: response.result.revision })
        ports.set(state => state.creations[key] !== retained ? state : { ...state, creations: Object.fromEntries(Object.entries(state.creations).filter(([id]) => id !== key)) })
        await ports.checkpoint()
      } else throw new Error('The original file creation is retained. This API has no creation operation ID; checking the current file cannot prove the missing original ACK.')
    },
    async inspectCreation(key: string) {
      const held = ports.get().creations[key]
      if (!held) return
      const observed = (await ports.api.call(held.target, 'file.read', { zoneId: held.request.zoneId, path: held.request.path,
        expectedResource: { hostId: held.request.expectedResource.hostId, workspaceId: held.request.expectedResource.workspaceId, workspacePath: held.request.expectedResource.workspacePath } })).result
      ports.set(state => state.creations[key] !== held ? state : { ...state, creations: { ...state.creations, [key]: { ...held,
        issue: `Current file: ${observed.result.status}. The original creation ACK remains unconfirmed; the saved request was not repeated.` } } })
      await ports.checkpoint()
      return observed
    },
    async mkdir(workspaceId: string, path: string) {
      const input = locator(workspaceId), observed = await stat(input, path)
      await dispatch(workspaceId, { action: 'mkdir', request: parseFileMkdirParams({ ...sourceFilesQuery(input.locator!, path), operationId: mintObjectId(), expectedResource: observed.resource,
        expectedAbsent: true, expected: { root: observed.observation.root, parent: observed.observation.parent } }) })
    },
    async move(workspaceId: string, path: string, nextPath: string) {
      const input = locator(workspaceId), source = await stat(input, path), destination = await stat(input, nextPath)
      await dispatch(workspaceId, { action: 'move', request: parseFileMoveParams({ ...sourceFilesQuery(input.locator!, path), operationId: mintObjectId(), expectedResource: source.resource,
        expected: { root: source.observation.root, parent: source.observation.parent, entry: source.observation.entry }, destination: { ...sourceFilesQuery(input.locator!, nextPath), expectedResource: destination.resource,
          expectedAbsent: true, expected: { root: destination.observation.root, parent: destination.observation.parent } } }) })
    },
    async delete(workspaceId: string, path: string) {
      const input = locator(workspaceId), observed = await stat(input, path, true)
      await dispatch(workspaceId, { action: 'delete', request: parseFileDeleteParams({ ...sourceFilesQuery(input.locator!, path), operationId: mintObjectId(), expectedResource: observed.resource,
        expected: { root: observed.observation.root, parent: observed.observation.parent, entry: observed.observation.entry },
        ...(observed.observation.entry.kind === 'directory' ? { recursive: true } : {}),
        ...(observed.observation.revision?.status === 'observed' ? { expectedRevision: observed.observation.revision.revision } : {}) }) })
    },
    async inspect(operationId: string) {
      const pending = ports.get().pending[operationId]
      if (!pending) return
      const observed = (await ports.api.call(pending.target, 'file.mutation.inspect', { zoneId: pending.request.zoneId, path: pending.request.path,
        ...(pending.request.spaceId ? { spaceId: pending.request.spaceId } : {}), expectedResource: pending.request.expectedResource, operationId })).result
      // Never redispatch. Original request bytes remain until a confirmed original result.
      if (observed.result.action !== 'unknown' && mutationConfirmed(observed.result)) {
        const selected = ports.get().selections[pending.workspace.id]
        if (selected?.locator && current(selected) && JSON.stringify(selected.target) === JSON.stringify(pending.target)) {
          const { original, ...receipt } = observed.result
          const effect = { type: 'path-mutation', action: observed.result.action, request: original, receipt: { operationId, resource: observed.resource,
            ...(observed.result.action === 'move' ? { destination: original && 'destination' in original ? original.destination.expectedResource : null } : {}), result: receipt } } as FileMutationEffect
          await ports.prepareEffect(pending.workspace.id, selected.locator)(effect)
        }
        ports.set(state => state.pending[operationId] !== pending ? state : { ...state, pending: Object.fromEntries(Object.entries(state.pending).filter(([id]) => id !== operationId)) })
        await ports.checkpoint()
      }
      return observed
    }
  }
}
