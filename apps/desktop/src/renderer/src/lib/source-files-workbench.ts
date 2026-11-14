import { mintObjectId } from '@agentmux/core/object-id'
import { parseFileDeleteParams, parseFileMkdirParams, parseFileMoveParams, type FileMutationEffect } from '@agentmux/core/files'
import type { FolderDirectoryRegistration } from '@agentmux/core/space-folder'
import type { SpaceMountSourceTarget } from '../../../shared/space-mount'
import type { SpaceMountRecord } from '../../../shared/space-mount'
import type { SourceFilesLocator, SourceFilesResolution } from '../../../shared/source-files'
import type { SourceFilesApi } from '../../../shared/source-files-client'
import { topicFileDirectory } from './topic-files-address'
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
export type SourceFilesPending = Mutation & { target: SpaceMountSourceTarget; workspace: SourceFilesInput['workspace']; objectDirectory?: string; observed?: FileMutationEffect; issue?: string | undefined }
export type SourceFileCreation = { workspace: SourceFilesInput['workspace']; target: SpaceMountSourceTarget; request: import('@agentmux/core/files').FileCreateParams; objectDirectory?: string; issue?: string }
export type SourceFolderRequest = { workspace: SourceFilesInput['workspace']; target: SpaceMountSourceTarget; packet: FolderDirectoryRegistration; issue?: string }
export type SourceFileReadPointer = { workspaceId: string; path: string; source: NonNullable<import('../../../shared/contracts').FileDocument['readSource']> }
export type SourceFilesInputs = { selections: Record<string, SourceFilesInput>; pending: Record<string, SourceFilesPending>; creations: Record<string, SourceFileCreation>; folderRequests: Record<string, SourceFolderRequest>; readSources?: Record<string, SourceFileReadPointer> }
export const emptySourceFilesInputs = (): SourceFilesInputs => ({ selections: {}, pending: {}, creations: {}, folderRequests: {} })
function mutationConfirmed(receipt: import('@agentmux/core/files').FilePathMutationReceipt | import('@agentmux/core/files').FileMoveReceipt | import('@agentmux/core/files').FileDeleteReceipt): boolean {
  return receipt.durability === 'confirmed' && receipt.filesystem !== 'unknown' &&
    (!('noteMetadata' in receipt) || receipt.noteMetadata?.status !== 'unconfirmed') &&
    (!('noteHistory' in receipt) || receipt.noteHistory?.status !== 'unconfirmed') &&
    (!('nameAudit' in receipt) || receipt.nameAudit?.status !== 'unconfirmed')
}
export const sourceFilesWorkspaceMatches = (left: SourceFilesInput['workspace'], right: SourceFilesInput['workspace'] | undefined) =>
  Boolean(right && left.id === right.id && left.hostId === right.hostId && left.path === right.path)
const sameFilesLocation = (left: SpaceMountRecord, right: SpaceMountRecord | undefined) => right?.hostId === left.hostId &&
  right.reference.runtimeId === left.reference.runtimeId && right.reference.spaceId === left.reference.spaceId &&
  right.zoneId === left.zoneId && right.workspaceId === left.workspaceId
export function sourceFilesQuery(locator: Pick<SourceFilesLocator, 'resource'>, path: string) {
  return { zoneId: locator.resource.zoneId, path: path || '.', expectedResource: {
    hostId: locator.resource.hostId, workspaceId: locator.resource.workspaceId, workspacePath: locator.resource.workspacePath
  } }
}
/** A live Zone may change independently; its later path cannot replace the selected mapping. */
export function sourceFilesMappingMatches(locator: Pick<SourceFilesLocator, 'resource'>, resource: import('@agentmux/core/files').FileReadResource, path: string): boolean {
  const base = locator.resource.path === '.' ? '' : locator.resource.path
  const expected = !path || path === '.' ? base : base ? base + '/' + path : path
  return ['hostId', 'workspaceId', 'workspacePath', 'zoneId', 'zonePath', 'logicalDirectory'].every(key =>
    resource[key as keyof typeof resource] === locator.resource[key as keyof typeof resource]) && (resource.path === '.' ? '' : resource.path) === expected
}

/** Files in a selected Source are shown Zone-relative. Topic files keep their Workspace-relative editor keys. */
export type FileMutationLocation = {
  workspace: SourceFilesInput['workspace']
  target: SpaceMountSourceTarget
  resource: SourceFilesLocator['resource']
  displayRoot?: string
  current(): boolean
}
export function mutationQuery(location: FileMutationLocation, path: string) {
  if (!location.displayRoot) return sourceFilesQuery(location, path)
  if (!path.startsWith(location.displayRoot + '/') || path === location.displayRoot + '/') throw new Error('Choose an entry inside the original Topic directory.')
  return sourceFilesQuery(location, path.slice(location.displayRoot.length + 1))
}
export function sameFilesRuntime(a: SpaceMountSourceTarget, b: SpaceMountSourceTarget) {
  const runtime = (t: SpaceMountSourceTarget) => 'reference' in t ? t.reference.runtimeId : t.expectedRuntimeId
  return a.hostId === b.hostId && runtime(a) === runtime(b)
}
export function selectedMutationLocation(input: SourceFilesInput, locator: SourceFilesLocator, current: () => boolean): FileMutationLocation {
  return { workspace: input.workspace, target: input.target, resource: locator.resource, current }
}

/** The existing UserState owns custody; every effect uses the original typed Source port. */
export function createSourceFilesWorkbench(ports: {
  api: SourceFilesApi
  get(): SourceFilesInputs
  set(update: (current: SourceFilesInputs) => SourceFilesInputs): void
  workspace(id: string): SourceFilesInput['workspace'] | undefined
  checkpoint(): Promise<void>
  runtime(hostId: string): Promise<string>
  location?(workspaceId: string, runtimeId: string): SpaceMountRecord | undefined
  register(hostId: string, packet: FolderDirectoryRegistration): Promise<import('@agentmux/core/space-folder').FolderSpaceReceipt>
  topicAddress(workspaceId: string, directory: string): { workspace: SourceFilesInput['workspace']; zoneId: string } | undefined
  prepareEffect(location: FileMutationLocation): (effect: FileMutationEffect) => Promise<void>
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
        input = { workspace: baseline, target: { hostId: baseline.hostId, expectedRuntimeId: runtimeId },
          selection: { kind: 'directory', path: baseline.path } }
      }
    }
    // Files follows the exact current Work location. Previously opened documents
    // and pending effects keep their own original Source addresses.
    const runtimeId = 'expectedRuntimeId' in input.target ? input.target.expectedRuntimeId : input.target.reference.runtimeId
    const mount = ports.location?.(workspaceId, runtimeId)
    const observedLocation = JSON.stringify(mount ?? null)
    const known = input.selection.kind === 'mount' ? input.selection.mount : input.selection.registration ?? input.locator?.mount
    if (mount && !sameFilesLocation(mount, known)) input = { workspace: structuredClone(workspace),
      target: { hostId: mount.hostId, reference: mount.reference }, selection: { kind: 'mount', mount } }
    // A default observation is not a selected Source. Adopt only a confirmed locator;
    // failure must leave the original Workspace's existing Files path available.
    const original = ports.get().selections[workspaceId]
    const owns = () => sourceFilesWorkspaceMatches(input.workspace, ports.workspace(workspaceId)) && ports.get().selections[workspaceId] === original &&
      observedLocation === JSON.stringify(ports.location?.(workspaceId, 'expectedRuntimeId' in input.target ? input.target.expectedRuntimeId : input.target.reference.runtimeId) ?? null)
    if (!owns()) return { status: 'unconfirmed', issue: { code: 'SOURCE_FILES_SELECTION_CHANGED', message: 'Restore the original directory selection to check its retained requests.' } }
    const selection = input.registration ? { kind: 'directory' as const, path: input.registration.directory.workspacePath,
      expectedResource: input.registration.directory, ...(input.selection.kind === 'directory' && input.selection.registration ? { registration: input.selection.registration } : {}) } : input.selection
    const result = await ports.api.resolve(input.target, selection)
    if (!owns()) return { status: 'unconfirmed', issue: { code: 'SOURCE_FILES_SELECTION_CHANGED', message: 'Later directory selection was retained; the old observation was not adopted.' } }
    if (result.status === 'located' || original) {
      const observed = { ...input, ...(result.status === 'located' ? { locator: result.locator, issue: undefined } : {
        issue: result.status === 'unconfirmed' ? result.issue.message : result.status === 'selection-required' ? 'Choose the original Source registration before changing files.' : undefined }) }
      const retained = input !== original && original?.registration && original.registrationStatus !== 'confirmed'
        ? { workspace: original.workspace, target: original.target, packet: original.registration } : undefined
      const key = retained ? mintObjectId() : undefined
      ports.set(state => state.selections[workspaceId] !== original ? state : { ...state, selections: { ...state.selections, [workspaceId]: observed },
        ...(key && retained ? { folderRequests: { ...state.folderRequests, [key]: retained } } : {}) })
    }
    return result
  }
  const useFolder = async (workspaceId: string, packet: FolderDirectoryRegistration) => {
    let input = ports.get().selections[workspaceId]
    if (!input) {
      const workspace = ports.workspace(workspaceId)
      if (!workspace || packet.directory.workspacePath !== workspace.path) throw new Error('Use the packet for this exact original Workspace directory.')
      const baseline = structuredClone(workspace), runtimeId = await ports.runtime(workspace.hostId)
      if (runtimeId !== packet.runtimeId || !sourceFilesWorkspaceMatches(baseline, ports.workspace(workspaceId)) || ports.get().selections[workspaceId]) throw new Error('The original Source changed before this folder selection. No registration was sent.')
      input = { workspace: baseline, target: { hostId: baseline.hostId, expectedRuntimeId: runtimeId }, selection: { kind: 'directory', path: baseline.path } }
      const chosen = input
      ports.set(state => ({ ...state, selections: { ...state.selections, [workspaceId]: chosen } }))
    }
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
  const selectedLocation = (workspaceId: string) => {
    const selected = ports.get().selections[workspaceId]
    if (!selected?.locator || !current(selected)) return undefined
    return selectedMutationLocation(selected, selected.locator, () => current(selected))
  }
  const ownsTopic = (workspace: SourceFilesInput['workspace'], directory: string, zoneId: string) => {
    const current = ports.topicAddress(workspace.id, directory)
    return current?.zoneId === zoneId && sourceFilesWorkspaceMatches(workspace, current.workspace)
  }
  const location = async (workspaceId: string, path: string, directory?: string | null): Promise<FileMutationLocation> => {
    if (!directory) {
      const selected = selectedLocation(workspaceId)
      if (!selected) throw new Error('Use the original Source folder in Files before changing this directory. Existing editors remain available.')
      return selected
    }
    if (topicFileDirectory(workspaceId, path) !== directory) throw new Error('Choose an entry inside the original Topic directory.')
    const address = ports.topicAddress(workspaceId, directory)
    if (!address) throw new Error('The original Topic directory is unconfirmed. Refresh its files before retrying.')
    const { workspace, zoneId } = address
    const target = { hostId: workspace.hostId, expectedRuntimeId: await ports.runtime(workspace.hostId) }
    const owns = () => ownsTopic(workspace, directory, zoneId)
    const observed = await ports.api.call(target, 'file.stat', { zoneId, path: '.', expectedResource: {
      hostId: workspace.hostId, workspaceId, workspacePath: workspace.path
    } })
    const resource = observed.result.resource
    if (!owns() || !observed.carrierCurrent || observed.result.result.status !== 'observed' || !resource ||
        resource.zoneId !== zoneId || resource.path !== directory || resource.hostId !== workspace.hostId ||
        resource.workspaceId !== workspaceId || resource.workspacePath !== workspace.path)
      throw new Error('The original Topic file mapping is unconfirmed. Refresh its files before retrying.')
    return { workspace, target, resource, displayRoot: directory, current: owns }
  }
  const stat = async (input: FileMutationLocation, path: string, revision = false) => {
    const query = mutationQuery(input, path)
    const reply = await ports.api.call(input.target, 'file.stat', { ...query, ...(revision ? { includeRevision: true } : {}) })
    const result = reply.result
    if (!input.current() || !reply.carrierCurrent || !result.resource || result.result.status !== 'observed' || !sourceFilesMappingMatches(input, result.resource, query.path)) throw new Error('The exact original file generation or Source mapping is unconfirmed. No mutation was sent.')
    return { resource: result.resource, observation: result.result.observation, query }
  }
  const sameOwner = (held: SourceFilesPending | SourceFileCreation, input: FileMutationLocation) =>
    sourceFilesWorkspaceMatches(held.workspace, input.workspace) && sameFilesRuntime(held.target, input.target) && held.request.zoneId === input.resource.zoneId
  const dispatch = async (input: FileMutationLocation, mutation: Mutation) => {
    const operationId = mutation.request.operationId
    if (Object.values(ports.get().pending).some(item => sameOwner(item, input) && item.action === mutation.action &&
        item.request.expectedResource.path === mutation.request.expectedResource.path)) throw new Error('Check the retained original request before repeating this action.')
    const pending: SourceFilesPending = structuredClone({ ...mutation, workspace: input.workspace, target: input.target,
      ...(input.displayRoot ? { objectDirectory: input.displayRoot } : {}) })
    ports.set(state => ({ ...state, pending: { ...state.pending, [operationId]: pending } }))
    const consumeEffect = ports.prepareEffect(input)
    await ports.checkpoint()
    if (!input.current() || ports.get().pending[operationId] !== pending) throw new Error('The original request was saved. Later selection was preserved; no mutation was sent.')
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
      const original = ports.get().selections[workspaceId], workspace = ports.workspace(workspaceId)
      if (!workspace || registration.hostId !== workspace.hostId) throw new Error('The original directory selection is no longer current.')
      const input = original ?? { workspace: structuredClone(workspace), target: { hostId: workspace.hostId, reference: registration.reference },
        selection: { kind: 'directory' as const, path: workspace.path } }
      const owns = () => sourceFilesWorkspaceMatches(input.workspace, ports.workspace(workspaceId)) && ports.get().selections[workspaceId] === original
      if (!owns()) throw new Error('The original directory selection is no longer current.')
      const selection = { kind: 'directory' as const, path: input.workspace.path, registration: structuredClone(registration),
        ...(input.registration ? { expectedResource: input.registration.directory } : {}) }
      const retained = original?.registration && original.registrationStatus !== 'confirmed'
        ? { workspace: original.workspace, target: original.target, packet: original.registration } : undefined
      const known = input.locator?.mount
      const sameLocation = sameFilesLocation(registration, known)
      const selected: SourceFilesInput = { workspace: input.workspace, target: input.target, selection, ...(sameLocation ? { locator: input.locator } : {}) }
      const key = mintObjectId()
      ports.set(state => state.selections[workspaceId] !== original ? state : { ...state,
        selections: { ...state.selections, [workspaceId]: selected },
        folderRequests: retained ? { ...state.folderRequests, [key]: retained } : state.folderRequests })
      await ports.checkpoint()
      if (!current(selected)) throw new Error('Later Source selection was preserved. The old registration was not adopted.')
      let result: SourceFilesResolution
      try { result = await ports.api.resolve(selected.target, selection) }
      catch (cause) {
        replace(selected, { ...selected, issue: cause instanceof Error ? cause.message : String(cause) })
        throw cause
      }
      if (!current(selected)) throw new Error('Later Source selection was preserved. The old registration was not adopted.')
      replace(selected, { ...selected, ...(result.status === 'located' ? { locator: result.locator } : {
        issue: result.status === 'unconfirmed' ? result.issue.message : 'The selected working location is unconfirmed. Check its original Space.' }) })
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
    async createFile(workspaceId: string, path: string, objectDirectory?: string | null) {
      const input = await location(workspaceId, path, objectDirectory), observed = await stat(input, path)
      const request: import('@agentmux/core/files').FileCreateParams = { ...observed.query, expectedResource: observed.resource, content: '', expectedRevision: null }
      if (Object.values(ports.get().creations).some(item => sameOwner(item, input) && item.request.path === request.path)) throw new Error('The original file creation is retained. Check that exact file without creating it again.')
      const key = mintObjectId(), retained = structuredClone({ workspace: input.workspace, target: input.target, request,
        ...(input.displayRoot ? { objectDirectory: input.displayRoot } : {}) })
      ports.set(state => ({ ...state, creations: { ...state.creations, [key]: retained } }))
      const consume = ports.prepareEffect(input)
      await ports.checkpoint()
      if (!input.current() || ports.get().creations[key] !== retained) throw new Error('The original file creation was saved. Later selection was preserved; no creation was sent.')
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
    async mkdir(workspaceId: string, path: string, objectDirectory?: string | null) {
      const input = await location(workspaceId, path, objectDirectory), observed = await stat(input, path)
      await dispatch(input, { action: 'mkdir', request: parseFileMkdirParams({ ...observed.query, operationId: mintObjectId(), expectedResource: observed.resource,
        expectedAbsent: true, expected: { root: observed.observation.root, parent: observed.observation.parent } }) })
    },
    async move(workspaceId: string, path: string, nextPath: string, objectDirectory?: string | null) {
      if (objectDirectory && topicFileDirectory(workspaceId, nextPath) !== objectDirectory) throw new Error('Move entries within their original Topic directory.')
      const input = await location(workspaceId, path, objectDirectory), source = await stat(input, path), destination = await stat(input, nextPath)
      await dispatch(input, { action: 'move', request: parseFileMoveParams({ ...source.query, operationId: mintObjectId(), expectedResource: source.resource,
        expected: { root: source.observation.root, parent: source.observation.parent, entry: source.observation.entry }, destination: { ...destination.query, expectedResource: destination.resource,
          expectedAbsent: true, expected: { root: destination.observation.root, parent: destination.observation.parent } } }) })
    },
    async delete(workspaceId: string, path: string, objectDirectory?: string | null) {
      const input = await location(workspaceId, path, objectDirectory), observed = await stat(input, path, true)
      await dispatch(input, { action: 'delete', request: parseFileDeleteParams({ ...observed.query, operationId: mintObjectId(), expectedResource: observed.resource,
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
        const retained = pending.request.expectedResource
        const directory = pending.objectDirectory
        // Inspect settles the original request. Apply its effect only to the same live file namespace.
        const selected = selectedLocation(pending.workspace.id)
        const topicCurrent = () => !!directory && ownsTopic(pending.workspace, directory, retained.zoneId)
        const originalLocation = directory && topicCurrent() ? {
          workspace: pending.workspace, target: pending.target, resource: { ...retained, path: directory }, displayRoot: directory,
          current: topicCurrent
        } : selected
        if (originalLocation && originalLocation.current() && sameOwner(pending, originalLocation)) {
          const { original, ...receipt } = observed.result
          const effect = { type: 'path-mutation', action: observed.result.action, request: original, receipt: { operationId, resource: observed.resource,
            ...(observed.result.action === 'move' ? { destination: original && 'destination' in original ? original.destination.expectedResource : null } : {}), result: receipt } } as FileMutationEffect
          await ports.prepareEffect(originalLocation)(effect)
        }
        ports.set(state => state.pending[operationId] !== pending ? state : { ...state, pending: Object.fromEntries(Object.entries(state.pending).filter(([id]) => id !== operationId)) })
        await ports.checkpoint()
      } else {
        const issue = observed.result.message ?? `Original operation: ${observed.result.filesystem}. Durability: ${observed.result.durability}.`
        ports.set(state => state.pending[operationId] !== pending ? state : { ...state, pending: { ...state.pending, [operationId]: { ...pending, issue } } })
        await ports.checkpoint()
      }
      return observed
    }
  }
}
