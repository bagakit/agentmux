/** Durable resource identities; client routes and presentation positions do not rename them. */
export function directoryIdentity(hostId: string, path: string): string {
  if (!hostId || !(path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\'))) throw new Error('Space identity requires a host and an absolute durable directory.')
  return JSON.stringify([hostId, path])
}
export function homeZoneId(spaceId: string): string { return JSON.stringify([spaceId, 'home']) }
export function workspaceZoneId(spaceId: string, workspaceId: string): string { return JSON.stringify([spaceId, 'workspace', workspaceId]) }
