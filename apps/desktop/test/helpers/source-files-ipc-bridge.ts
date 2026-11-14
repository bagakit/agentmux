import { EventEmitter } from 'node:events'
import { registerSourceFilesIpc } from '../../src/main/source-files-ipc.js'
import { registerSpaceMountIpc } from '../../src/main/space-mount-ipc.js'
import { createPreloadSourceFiles } from '../../src/preload/source-files.js'
import { createRendererSourceFiles } from '../../src/renderer/src/lib/source-files-api.js'
import { createPreloadSpaceMount } from '../../src/preload/space-mount.js'
import { createRendererSpaceMount } from '../../src/renderer/src/lib/space-mount-api.js'
import type { RuntimeController } from '../../src/main/runtime-controller.js'

/** Only the window IPC transport is a controlled leaf. Both sides execute their product adapters. */
export function sourceFilesIpcBridge(runtime: RuntimeController, cleanup: Array<() => unknown | Promise<unknown>>) {
  const handlers = new Map<string, (...args: any[]) => any>(), events = new EventEmitter()
  const sender = Object.assign(new EventEmitter(), { id: 91, isDestroyed: () => false,
    send: (channel: string, value: unknown) => { events.emit(channel, {}, structuredClone(value)) } })
  const handle = (channel: string, listener: (...args: any[]) => any) => { handlers.set(channel, listener) }
  const reads = registerSourceFilesIpc({ handle, runtime }), mounts = registerSpaceMountIpc({ handle, runtime })
  cleanup.push(() => { reads.dispose(); mounts.dispose() })
  const ipc = { invoke: async (channel: string, ...args: unknown[]) => {
    const listener = handlers.get(channel)
    if (!listener) throw new Error('Missing real IPC handler: ' + channel)
    return await listener({ sender }, ...structuredClone(args))
  }, on: (channel: string, listener: (...args: any[]) => void) => { events.on(channel, listener) },
  removeListener: (channel: string, listener: (...args: any[]) => void) => { events.removeListener(channel, listener) } }
  return { files: createRendererSourceFiles(createPreloadSourceFiles(ipc as any)), spaces: createRendererSpaceMount(createPreloadSpaceMount(ipc as any)) }
}
