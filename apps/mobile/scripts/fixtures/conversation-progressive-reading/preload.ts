import { contextBridge, ipcRenderer } from 'electron'

const channel = 'reading-mobile:rpc'
type Handlers = { onInitial(value: unknown): void; onEvent(value: unknown): void; onEnd?(error?: unknown): void }
const readers = new Map<string, Handlers>()
ipcRenderer.on('reading-mobile:rpc-event', (_event, id: string, kind: 'initial' | 'event' | 'end', value: unknown) => {
  const reader = readers.get(id)
  if (kind === 'initial') reader?.onInitial(value)
  else if (kind === 'event') reader?.onEvent(value)
  else { readers.delete(id); reader?.onEnd(value) }
})

/** Only transport values cross this private bridge. The Main owner uses the original HTTP client. */
contextBridge.exposeInMainWorld('originalMobileRpc', {
  connect: (url: string, token: string) => ipcRenderer.invoke(channel, 'connect', url, token),
  call: (method: string, params: unknown, id: string, options: Record<string, unknown>) => ipcRenderer.invoke(channel, 'call', method, params, id, options),
  async subscribe(method: string, params: unknown, id: string, options: Record<string, unknown>, handlers: Handlers) {
    readers.set(id, handlers)
    try {
      const reply = await ipcRenderer.invoke(channel, 'subscribe', method, params, id, options)
      if (!reply.ok) readers.delete(id)
      return reply
    }
    catch (error) { readers.delete(id); throw error }
  },
  async cancel(id: string) { readers.delete(id); await ipcRenderer.invoke(channel, 'cancel', id) },
  async dispose() { readers.clear(); await ipcRenderer.invoke(channel, 'dispose') }
})
