import { nativeTheme } from 'electron'
import { avatarSeriesCanonical } from '@agentmux/core/mote-avatar-series'
import { AgentMuxError } from '@agentmux/core'
import { isObjectAvatarRef, parseObjectAvatarParams, parseObjectAvatarResult,
  avatarActorIdentity, parseAvatarActor, type AvatarActorIdentity, type ObjectAvatarMethod, type ObjectAvatarParamsMap, type ObjectAvatarResultMap, type SpaceObjectImageTarget,
  type SpaceObjectAvatarRead, type SpaceObjectAvatarSave, type AvatarExecutionContext } from '@agentmux/core/object-avatar'
import { savedMoteAvatarSnapshot } from '@agentmux/host/mote-avatar-state'
import { isSpaceIconId } from '@agentmux/client-ui/space-icon-ids'
import type { ConfigOwner } from './config-owner.js'
import type { ConfigStore } from './config-store.js'
import type { SpaceObjectImages } from './space-object-images.js'
import { AvatarPublicationWriter } from './avatar-publication.js'

export type SpaceObjectAvatarLocation = { hostId: string; directoryPath: string }
const issue = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 2048)
/** Original object identity, image owner and ConfigOwner meet only at this avatar boundary. */
export class SpaceObjectAvatarOwner {
  private readonly publication: AvatarPublicationWriter
  constructor(private readonly config: ConfigOwner, store: Pick<ConfigStore, 'confirmSaved'>, private readonly images: SpaceObjectImages,
    private readonly resolve: (target: SpaceObjectImageTarget) => Promise<SpaceObjectAvatarLocation>) {
    const target = (value: SpaceObjectImageTarget | import('@agentmux/core/mote-avatar-write').MoteAvatarTarget) => {
      if (!('kind' in value)) throw new Error('Choose the original Category or ordinary Topic avatar.')
      return value
    }
    this.publication = new AvatarPublicationWriter(config, undefined, {
      directory: async value => {
        const location = await resolve(target(value))
        if (location.hostId !== 'local') throw new AgentMuxError('Image publication requires this object’s existing local directory. Its semantic icon configuration and current work remain available.', 'AVATAR_LOCAL_IMAGE_UNSUPPORTED')
        return await images.directory(target(value))
      },
      save: (value, input) => images.save(target(value), input), prefersDark: () => nativeTheme.shouldUseDarkColors,
      confirm: value => store.confirmSaved(value)
    })
  }
  private async read(target: SpaceObjectImageTarget, readerIdentity: AvatarActorIdentity, operationId?: string): Promise<SpaceObjectAvatarRead> {
    const location = await this.resolve(target)
    const current = await this.config.inspect(config => savedMoteAvatarSnapshot(config.appearance, target.objectKey))
    const result: SpaceObjectAvatarRead = { target, readerIdentity, ...current, localCapability: location.hostId === 'local' ? { state: 'available' } : { state: 'unsupported', issue: 'Static image assets are available only in this object’s existing local directory. Icon/reset remains available.' }, issues: [] }
    if (operationId !== undefined) {
      if (location.hostId !== 'local') result.issues.push('This remote object has no local asset operation directory. Its current configuration is retained.')
      else try { const operation = await this.publication.inspect(target, operationId); if (operation) result.operation = operation as NonNullable<SpaceObjectAvatarRead['operation']> }
      catch (error) { result.localCapability = { state: 'unknown', issue: issue(error) }; result.issues.push(issue(error)) }
    }
    if (isObjectAvatarRef(current.choice)) {
      if (location.hostId === 'local') {
        try { result.image = await this.images.read(target, current.choice) }
        catch (error) { result.localCapability = { state: 'unknown', issue: issue(error) }; result.issues.push(issue(error)) }
      }
    } else if (current.choice !== null && !isSpaceIconId(current.choice)) result.issues.push('This saved avatar choice is unsupported. Its original value is retained; inspect before an explicit new choice.')
    return result
  }
  async call<M extends ObjectAvatarMethod>(method: M, value: ObjectAvatarParamsMap[M], context: AvatarExecutionContext): Promise<ObjectAvatarResultMap[M]> {
    const input = parseObjectAvatarParams(method, value)
    const readerIdentity = avatarActorIdentity(parseAvatarActor(context?.actor, 'CONTROL_PERMISSION_DENIED'))
    if (method === 'space.object.avatar.read') return parseObjectAvatarResult(method, await this.read(input.target, readerIdentity, input.operationId), input)
    const request = input as SpaceObjectAvatarSave
    let result
    if (request.choice !== null && typeof request.choice === 'object') {
      const published = await this.publication.save(request, context)
      result = { mode: 'asset-publication' as const, ...published, current: await this.read(request.target, readerIdentity, request.operationId) }
    } else {
      parseAvatarActor(context?.actor, 'CONTROL_PERMISSION_DENIED')
      await context.assertCurrent()
      const location = await this.resolve(request.target)
      if (request.choice !== null && !isSpaceIconId(request.choice)) throw new AgentMuxError('Choose one of this App’s existing semantic icons.', 'INVALID_CONTROL_REQUEST')
      try {
        const after = await this.resolve(request.target)
        if (avatarSeriesCanonical(after) !== avatarSeriesCanonical(location)) throw new Error('The original object changed before this icon configuration save.')
        await this.config.update(current => {
          if (savedMoteAvatarSnapshot(current.appearance, request.target.objectKey).revision !== request.beforeRevision) throw new AgentMuxError('The original object appearance changed. Read its current choice before deciding a new save.', 'CONFIG_CONFLICT')
          const icons = { ...current.appearance.spaceObjectIcons }
          if (request.choice === null) delete icons[request.target.objectKey]
          else Object.defineProperty(icons, request.target.objectKey, { value: request.choice, enumerable: true, configurable: true, writable: true })
          return { ...current, appearance: { ...current.appearance, spaceObjectIcons: icons } }
        })
        result = { mode: 'configuration-only' as const, state: 'saved' as const, current: await this.read(request.target, readerIdentity) }
      } catch (error) {
        // Current values are only current values; a lost save ACK is never inferred from them.
        result = { mode: 'configuration-only' as const, state: (error as { code?: string }).code === 'CONFIG_CONFLICT' ? 'refused' as const : 'unknown' as const, issue: issue(error), current: await this.read(request.target, readerIdentity) }
      }
    }
    return parseObjectAvatarResult(method, result, input)
  }
}
