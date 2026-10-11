import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { AgentMuxClient } from '../../../../packages/core/src/client'
import { AgentMuxControlServer } from '../../../../packages/core/src/public-rpc-server'
import { connectAgentMuxRpc } from '../../../../packages/core/src/public-rpc-client'
import { registerConversationReadIpc } from '../../src/main/conversation-read-ipc'
import { createPreloadConversationRead } from '../../src/preload/conversation-read'
import { createConversationReadApi } from '../../src/renderer/src/lib/conversation-read-api'
import { api } from '../../src/renderer/src/lib/api'

/** Real public service, Unix transport, Main IPC, preload and strict Renderer API.
 * The supplied clients own all source facts; this fixture only replaces Electron
 * EventEmitter delivery and registers its exact cleanup with the owning test. */
export async function desktopConversationReadBridge(f: { root: string; client: AgentMuxClient }, closes: Array<() => unknown | Promise<unknown>>, clients = () => [{ hostId: 'local', client: f.client }]) {
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'conversation.sock'), coreClients: clients })
  await server.start(); closes.push(() => server.stop())
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: any[]) => unknown>(), events = new EventEmitter()
  const sender = Object.assign(new EventEmitter(), { id: 81, isDestroyed: () => false,
    send: (channel: string, value: unknown) => events.emit(channel, null, structuredClone(value)) })
  const event = { sender } as unknown as IpcMainInvokeEvent
  const transport = registerConversationReadIpc({ handle: (channel, fn) => { handlers.set(channel, fn) },
    trust: (_channel, target) => { expect(target.sender).toBe(sender) }, connect: () => connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }) })
  closes.push(() => transport.dispose())
  const bridge = createPreloadConversationRead({ invoke: async (channel, ...args) => structuredClone(await handlers.get(channel)!(event, ...structuredClone(args))),
    on: (channel, listener) => events.on(channel, listener), removeListener: (channel, listener) => events.removeListener(channel, listener) })
  const publicRead = createConversationReadApi(bridge)
  for (const name of ['readAgentConversation', 'readConversationChanges', 'observeConversation', 'releaseConversationView'] as const) vi.spyOn(api.conversation, name).mockImplementation(publicRead[name] as never)
  return publicRead
}
