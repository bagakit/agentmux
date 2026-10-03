import { AVATAR_INPUT_MAX_BYTES, AVATAR_MAX_DIMENSION, AVATAR_MAX_PIXELS, AVATAR_EDGE, AVATAR_OUTPUT_MAX_BYTES, AVATAR_PREVIEW_MAX_BYTES, isObjectAvatarRef } from './object-avatars.js'
import type { ObjectAvatarRef, ObjectAvatarInput, ObjectAvatarImage } from './object-avatars.js'
export const MOTE_AVATAR_INPUT_MAX_BYTES = AVATAR_INPUT_MAX_BYTES
export const MOTE_AVATAR_MAX_DIMENSION = AVATAR_MAX_DIMENSION
export const MOTE_AVATAR_MAX_PIXELS = AVATAR_MAX_PIXELS
export const MOTE_AVATAR_EDGE = AVATAR_EDGE
export const MOTE_AVATAR_OUTPUT_MAX_BYTES = AVATAR_OUTPUT_MAX_BYTES
export const MOTE_AVATAR_PREVIEW_MAX_BYTES = AVATAR_PREVIEW_MAX_BYTES
export type MoteAvatarTarget = { workspaceId: string; topicId: string; objectKey: string }
export type MoteAvatarRef = ObjectAvatarRef
export type MoteAvatarInput = ObjectAvatarInput
export type MoteAvatarImage = ObjectAvatarImage
export const isMoteAvatarRef = isObjectAvatarRef

/** Small, authored parts. No markup, executable text or remote resources are accepted. */
export { MOTE_FACE_PARTS, DEFAULT_MOTE_FACE, isMoteFace, type MoteFace } from '@agentmux/client-ui/mote-face'
