export * from './mote-topic-model.js'
export * from './mote-quick-mode.js'
export * from './mote-behavior.js'
export * from './mote-behavior-legacy.js'
export * from './mote-agent-instructions.js'
export * from './mote-user-profile.js'
/** Durable directory identity; presentation positions do not route Agent execution. */
export function directoryIdentity(hostId: string, path: string): string {
  if (!hostId || !(path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\'))) throw new Error('Space identity requires a host and an absolute durable directory.')
  return JSON.stringify([hostId, path])
}
export function homeZoneId(spaceId: string): string { return JSON.stringify([spaceId, 'home']) }
