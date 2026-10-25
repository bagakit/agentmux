const observation = { calls: 0 }
// The fixture supplies the real provider avatar through describeSpeaker.
export function ConversationMessageAvatar(): never {
  observation.calls++
  throw new Error('The supplied-avatar fixture must not read the global identity fallback')
}
export const unusedAvatarCalls = () => observation.calls
