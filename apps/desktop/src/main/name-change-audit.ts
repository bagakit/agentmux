import type { AgentMuxNameContext } from '@agentmux/core/control'

export function unknownNameContext(entryPoint: string): AgentMuxNameContext {
  return { actor: { kind: 'unknown', id: null, verified: false }, source: 'owner', entryPoint,
    transport: null, location: {} }
}

export function desktopNameContext(entryPoint: string, sender: unknown, expected: unknown,
  windowId: number): AgentMuxNameContext {
  if (!Object.is(sender, expected)) return unknownNameContext(entryPoint)
  const webContentsId = (sender as { id?: number }).id
  const uid = process.getuid?.()
  return { actor: uid === undefined ? { kind: 'unknown', id: null, verified: false }
    : { kind: 'device', id: `local-user:${uid}`, verified: true },
    source: 'desktop-ui', entryPoint, transport: 'electron-ipc',
    location: { windowId: String(windowId), webContentsId: webContentsId === undefined ? null : String(webContentsId) } }
}

