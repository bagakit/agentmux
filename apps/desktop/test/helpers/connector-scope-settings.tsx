import { act } from 'react'
import { expect, vi } from 'vitest'
import { registerConnectorIpc } from '../../src/main/connector-ipc.js'
import { unwrapSessionInputOperationResult } from '../../src/shared/session-input-result.js'
import { ExternalConnectionsSettings } from '../../src/renderer/src/components/settings/ExternalConnectionsSettings.js'
import { api } from '../../src/renderer/src/lib/api.js'
import { composerDOM } from './composer-dom-fixture.js'

/** Read the original connection Settings through its actual IPC/RPC owner without adding a renderer fact store. */
export function connectorScopeSettings() {
  const dom = composerDOM()
  return async (input: { socketPath: string; secrets: Parameters<typeof registerConnectorIpc>[0]['secrets']; connectionId: string }) => {
    const handlers = new Map<string, (...args: any[]) => Promise<any>>()
    registerConnectorIpc({ handleWithEvent: (channel, handler) => { handlers.set(channel, handler) }, assertTrusted: () => undefined, socketPath: input.socketPath, secrets: input.secrets })
    vi.spyOn(api.connections, 'call').mockImplementation(async (method, params) => unwrapSessionInputOperationResult(await handlers.get('connections:call')!({}, method, params)))
    await dom.render(<ExternalConnectionsSettings active />)
    await vi.waitFor(async () => {
      await act(async () => { await new Promise<void>(resolve => setImmediate(resolve)) })
      expect(dom.container.querySelector('[data-connection]'), dom.container.textContent ?? '').not.toBeNull()
    })
    const record = Array.from(dom.container.querySelectorAll<HTMLElement>('[data-connection]')).find(item => item.dataset.connection === input.connectionId)!
    expect(record).not.toBeUndefined()
    await act(async () => { record.querySelector<HTMLButtonElement>('.connector-record__open')!.click() })
    const delivery = () => dom.container.querySelector<HTMLElement>('[data-connection-setup-result] [data-connection-stage="delivery"]')
    await vi.waitFor(() => expect(delivery()?.querySelector('dd')?.textContent).toBe('View delivery in each Agent’s Shared group details'))
    return { text: dom.container.textContent, groupDeliveryText: delivery()!.querySelector('dd')?.textContent }
  }
}
