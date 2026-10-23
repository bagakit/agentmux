import { act } from 'react'
import { expect, vi } from 'vitest'
import { connectAgentMuxRpc } from '@agentmux/core'
import { registerConnectorIpc } from '../../src/main/connector-ipc.js'
import type { ConnectionHostIpc } from '../../src/main/connection-host-ipc.js'
import type { ConnectionHostingTarget } from '../../src/shared/contracts.js'
import { unwrapSessionInputOperationResult } from '../../src/shared/session-input-result.js'
import { ExternalConnectionsSettings } from '../../src/renderer/src/components/settings/ExternalConnectionsSettings.js'
import { api } from '../../src/renderer/src/lib/api.js'
import { connectionSettingsPort } from '../../src/renderer/src/lib/connection-settings-port.js'
import { composerDOM } from './composer-dom-fixture.js'

/** Read the original connection Settings through its actual IPC/RPC owner without adding a renderer fact store. */
export function connectorScopeSettings() {
  const dom = composerDOM()
  return async (input: { socketPath: string; connectionId: string }) => {
    // This readonly fixture pins its controlled route to the original public endpoint.
    const hostingTarget: ConnectionHostingTarget = { hostId: 'local', runtimeId: 'scope-settings-fixture-runtime' }
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: input.socketPath } })
    const runtime: ConnectionHostIpc = {
      connectionHostingTarget: async () => hostingTarget,
      callConnectionHost: (target, method, params) => { expect(target).toEqual(hostingTarget); return rpc.call(method, params) },
      watchConnectionMetadata: (target, handlers) => { expect(target).toEqual(hostingTarget); return rpc.subscribe('connection.metadata.watch', {}, handlers) }
    }
    const handlers = new Map<string, (...args: any[]) => Promise<any>>()
    const sender = {}, ipc = registerConnectorIpc({ handleWithEvent: (channel, handler) => { handlers.set(channel, handler) }, assertTrusted: (_channel, event) => expect(event.sender).toBe(sender), runtime, metadata: { publish() {}, observation() {} } })
    vi.spyOn(api.connections, 'call').mockImplementation(async (method, params, target) => unwrapSessionInputOperationResult(await handlers.get('connections:call')!({ sender }, method, params, target)))
    try {
      await dom.render(<ExternalConnectionsSettings connections={connectionSettingsPort(hostingTarget)} hostingTarget={hostingTarget} active />)
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
    } finally { await dom.render(null); ipc.dispose(); await rpc.dispose() }
  }
}
