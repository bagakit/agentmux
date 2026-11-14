import { parseObjectAvatarParams, type SpaceObjectAvatarSave, type SpaceObjectImageTarget } from '@agentmux/core/object-avatar'
import { avatarSeriesCanonical } from '@agentmux/core/mote-avatar-series'
export type ObjectAvatarAssetRequest = Extract<SpaceObjectAvatarSave, { operationId: string }>
export type ObjectAvatarRequestRecord = { request: ObjectAvatarAssetRequest; createdAt: number }
export function objectAvatarRequest(input: unknown): ObjectAvatarAssetRequest {
  const value = parseObjectAvatarParams('space.object.avatar.save', input)
  if (value.choice === null || typeof value.choice !== 'object' || !value.operationId) throw new Error('Only an exact original PNG publication request belongs in this client draft member.')
  return value as ObjectAvatarAssetRequest
}
export function objectAvatarRequestKey(target: SpaceObjectImageTarget): string {
  return avatarSeriesCanonical(parseObjectAvatarParams('space.object.avatar.read', { target }).target)
}
