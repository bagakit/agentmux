import { isObjectId } from '@agentmux/core/object-id'

// Existing persisted IDs are opaque identities, not candidates for replacement.
const originalId = /^(launcher|session|view):([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/
const originalDirectory = /^topic--(launcher|session|view)--([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/
export function isScratchTopicId(id) { return isObjectId(id) || originalId.test(id) }
export function scratchTopicDirectoryName(id) {
  if (isObjectId(id)) return `topic--${id}`
  const match = originalId.exec(id)
  if (!match) throw new Error('Invalid Scratch Topic identity')
  return `topic--${match[1]}--${match[2]}`
}
export function scratchTopicIdFromDirectoryName(name) {
  const id = name.startsWith('topic--') ? name.slice(7) : ''
  if (isObjectId(id)) return id
  const match = originalDirectory.exec(name)
  return match ? `${match[1]}:${match[2]}` : null
}
