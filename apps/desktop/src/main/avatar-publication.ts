import { join } from 'node:path'
import { AgentMuxError, durableWriteFile } from '@agentmux/core'
import { avatarActorIdentity, avatarRequestHash, parseAvatarActor,
  type AvatarExecutionContext, type AvatarPublicationOperation, type ObjectAvatarInput, type ObjectAvatarRef,
  type SpaceObjectImageTarget, type SpaceObjectAvatarSave } from '@agentmux/core/object-avatar'
import { avatarSeriesCanonical, type MoteAvatarSeriesChoice } from '@agentmux/core/mote-avatar-series'
import type { MoteAvatarSave, MoteAvatarTarget } from '@agentmux/core/mote-avatar-write'
import { moteAvatarOperationDirectory, readAvatarPublicationOperation, savedMoteAvatarSnapshot } from '@agentmux/host/mote-avatar-state'
import { moteAvatarRevision } from './mote-avatar-snapshot.js'
import type { ConfigOwner } from './config-owner.js'
import type { AppConfig } from '../shared/contracts.js'
import type { MoteAvatarSeriesOwner } from './mote-avatar-series.js'

type Target = MoteAvatarTarget | SpaceObjectImageTarget
type Choice = ObjectAvatarRef | MoteAvatarSeriesChoice
type Operation = AvatarPublicationOperation<Choice>
type Result = { state: 'saved' | 'refused' | 'unknown'; operation?: Operation; issue?: string }
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 2048)
function revision(config: AppConfig, target: Target, dark: boolean) {
  return 'kind' in target ? savedMoteAvatarSnapshot(config.appearance, target.objectKey).revision : moteAvatarRevision(config, target, dark)
}
function workspaceBinding(config: AppConfig, target: Target) {
  if ('kind' in target && target.kind === 'category') return null
  const workspace = config.workspaces.find(value => value.id === target.workspaceId)
  if (!workspace) throw new Error('The original avatar workspace is unavailable. Its saved choice and work are retained.')
  return { id: workspace.id, hostId: workspace.hostId, path: workspace.path, kind: workspace.kind }
}

/** Fixed avatar publication only: original immutable PNG + one appearance-key CAS.
 * Object/source validation remains with the existing Mote or Category/Topic owners.
 * No caller-supplied state updater, workflow, target registry or second configuration. */
export class AvatarPublicationWriter {
  private readonly active = new Map<string, Promise<void>>()
  constructor(private readonly config: ConfigOwner, private readonly sources: MoteAvatarSeriesOwner | undefined,
    private readonly original: {
      directory(target: Target): Promise<string>
      save(target: Target, input: ObjectAvatarInput): Promise<ObjectAvatarRef>
      prefersDark(): boolean
      confirm(saved: AppConfig): Promise<void>
    }) {}
  async inspect(target: Target, operationId: string): Promise<Operation | undefined> {
    return await readAvatarPublicationOperation(await this.original.directory(target), target, operationId) as Operation | undefined
  }
  private async record(target: Target, operation: Operation) {
    const directory = await moteAvatarOperationDirectory(await this.original.directory(target), true)
    const { actorAvailability: _derived, ...stored } = operation
    await durableWriteFile(join(directory, operation.operationId + '.json'), JSON.stringify({ schema: 'agentmux.avatar-operation.v1', target, operation: stored }) + '\n', { requireDirectorySync: true })
  }
  async save(request: MoteAvatarSave | SpaceObjectAvatarSave, context: AvatarExecutionContext | undefined): Promise<Result> {
    if (!context?.actor || typeof context.assertCurrent !== 'function') throw new AgentMuxError('This avatar write needs its original trusted actor context. The request, saved image and existing work are retained.', 'CONTROL_PERMISSION_DENIED')
    const input = structuredClone(request), actor = parseAvatarActor(context.actor, 'CONTROL_PERMISSION_DENIED')
    const key = avatarSeriesCanonical(input.target), previous = this.active.get(key)
    let release!: () => void
    const complete = new Promise<void>(done => { release = done }), reserved = Promise.resolve(previous).then(() => complete)
    this.active.set(key, reserved)
    await previous
    try { return await this.commit(input, { ...context, actor }) }
    finally { release(); if (this.active.get(key) === reserved) this.active.delete(key) }
  }
  private async commit(input: MoteAvatarSave | SpaceObjectAvatarSave, context: AvatarExecutionContext): Promise<Result> {
    const { target, operationId } = input
    if (!operationId) throw new AgentMuxError('An asset publication keeps its original operation ID.', 'INVALID_CONTROL_REQUEST')
    const requestHash = avatarRequestHash(input, context.actor)
    await context.assertCurrent()
    const binding = await this.config.inspect(config => workspaceBinding(config, target))
    const directory = await this.original.directory(target)
    let operation = await this.inspect(target, operationId)
    if (operation) {
      if (!operation.actor) {
        // Old records have no attributed writer. Query their original outcome, never adopt
        // an intent/asset as today's user or replay an unconfirmed publication.
        if (operation.requestHash !== avatarRequestHash(input)) return { state: 'refused', operation, issue: 'This legacy operation belongs to another original request. Its attribution remains unavailable.' }
        if (operation.phase === 'published' || operation.phase === 'publication-unknown') return { state: 'unknown', operation, issue: 'This legacy publication has no original actor. Read its historical record; it does not acknowledge this authenticated submission and was not replayed.' }
        return { state: 'refused', operation, issue: 'This legacy intent has no original actor. Keep it and use a new explicitly authorized operation with a fresh baseline; it was not resumed.' }
      }
      if (avatarSeriesCanonical(avatarActorIdentity(operation.actor)) !== avatarSeriesCanonical(avatarActorIdentity(context.actor)) || operation.requestHash !== requestHash)
        return { state: 'refused', operation, issue: 'This operation belongs to another original actor or request. No image or appearance was changed.' }
      if (operation.phase === 'publication-unknown' || operation.phase === 'published') return { state: operation.phase === 'published' && operation.durability === 'confirmed' ? 'saved' : 'unknown', operation }
    }
    try {
      if ('source' in input) {
        if (!this.sources) throw new Error('The original avatar series owner is unavailable.')
        const { origin, seriesId, entryId, revision } = input.source
        const prepared = await this.sources.preview({ source: { origin, seriesId, entryId }, expectedRevision: revision })
        if (avatarSeriesCanonical(prepared.definition) !== avatarSeriesCanonical(input.definition)) throw new Error('The selected original avatar definition changed.')
      }
      await this.config.inspect(config => { if (revision(config, target, this.original.prefersDark()) !== input.beforeRevision) throw new Error('This original avatar changed while editing. Inspect it before an explicit new save.') })
    } catch (error) { return { state: 'refused', ...(operation ? { operation } : {}), issue: message(error) } }
    try {
      operation ??= { operationId, requestHash, actor: context.actor, phase: 'intent', durability: 'unknown' }
      await this.record(target, operation)
      const pngDataUrl = 'pngDataUrl' in input ? input.pngDataUrl : typeof input.choice === 'object' && input.choice ? input.choice.dataUrl : undefined
      if (!pngDataUrl) throw new Error('An asset publication requires its original PNG input.')
      const image = await this.original.save(target, { mimeType: 'image/png', dataUrl: pngDataUrl })
      const choice: Choice = 'source' in input ? { kind: 'series', source: input.source, definition: input.definition, parameters: input.parameters, image } : image
      operation = { operationId, requestHash, actor: context.actor, phase: 'asset', durability: 'unknown', choice }
      await this.record(target, operation)
      operation = { ...operation, phase: 'publication-unknown' }
      await this.record(target, operation)
      await context.assertCurrent()
      if (await this.original.directory(target) !== directory) throw new Error('The original avatar object directory changed before publication. Its image and later choice are retained.')
      const saved = await this.config.update(current => {
        if (avatarSeriesCanonical(workspaceBinding(current, target)) !== avatarSeriesCanonical(binding)) throw new Error('The original avatar workspace changed before publication. Its choice and work are retained.')
        if (revision(current, target, this.original.prefersDark()) !== input.beforeRevision) throw new Error('This original avatar changed while the image was saving. Its later choice is retained.')
        return { ...current, appearance: { ...current.appearance, spaceObjectIcons: { ...current.appearance.spaceObjectIcons, [target.objectKey]: choice } } }
      })
      await this.original.confirm(saved)
      operation = { ...operation, phase: 'published', durability: 'confirmed' }
      await this.record(target, operation)
      return { state: 'saved', operation }
    } catch (error) { return { state: 'unknown', ...(operation ? { operation: { ...operation, issue: message(error) } } : {}), issue: message(error) } }
  }
}
