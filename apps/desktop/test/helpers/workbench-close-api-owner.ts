import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { vi } from 'vitest'
import { WorkbenchCloseOwner } from '../../src/main/workbench-close-owner'
import { api } from '../../src/renderer/src/lib/api'
import { useAppStore } from '../../src/renderer/src/store'

/** Existing UI fixtures supply the original resource port. Main owns close
 * admission/receipts; real Native and durable client consumers are separately
 * qualified by workbench-close-cli.test.ts. No preview fallback grants an ACK. */
export async function connectWorkbenchCloseApiOwner() {
  const directory = await mkdtemp('/tmp/cui-')
  const renderer = async (operation: 'workbench.close.reserve' | 'workbench.close.release' | 'workbench.close.commit' | 'workbench.close.validate', record: any, key?: string) =>
    useAppStore.getState().executeWorkbenchClose({ operation, requestId: 'private-ui-' + crypto.randomUUID(), record, ...(key ? { key } : {}) } as any)
  const owner = new WorkbenchCloseOwner({ path: join(directory, 'user.json') }, {
    authority: () => ({ ownerId: 'private-ui-owner', endpoint: 'private-ui', documentGeneration: 'private-ui-generation' }),
    capture: async input => {
      const result = await useAppStore.getState().executeWorkbenchClose({ operation: 'workbench.close.capture', requestId: 'private-ui-' + crypto.randomUUID(), input })
      if (result.operation !== 'workbench.close.capture') throw Error('The original Renderer did not return its plan.')
      return result.projection
    },
    prepareTerminal: async () => { throw Error('This UI fixture has no Native raw owner; its Terminal remains unconfirmed.') },
    reserve: async record => { await renderer('workbench.close.reserve', record) },
    validate: async (record, key) => { await renderer('workbench.close.validate', record, key) },
    release: async record => { await renderer('workbench.close.release', record) },
    commit: async record => {
      const result = await renderer('workbench.close.commit', record)
      if (result.operation !== 'workbench.close.commit') throw Error('The original Renderer did not return its projection result.')
      return result.result
    },
    inspect: async () => null,
    effect: async (resource, child) => {
      if (resource.kind === 'browser') {
        await api.browser.close(resource.browserId)
        return { key: child.key, operationId: child.operationId, outcome: 'acknowledged', receipt: { kind: 'browser-closed', browserId: resource.browserId } }
      }
      const receipt = await api.sessions.stop(resource.control, child.operationId)
      if (!receipt || resource.control.kind !== 'agent' || !('agentSessionId' in receipt)) throw Error('The original Agent Stop fixture returned no typed receipt.')
      return { key: child.key, operationId: child.operationId, outcome: 'acknowledged', receipt }
    }
  })
  const pending = new Set<Promise<unknown>>()
  const binding = vi.spyOn(api.workbenchClose, 'call').mockImplementation((method, input) => {
    const operation = owner.call(method, input, { actor: { kind: 'user', id: 'private-ui-person' }, originalContext: { transport: 'unix', principal: { kind: 'user', id: 'private-ui-person' } } })
    pending.add(operation); void operation.then(() => pending.delete(operation), () => pending.delete(operation))
    return operation
  })
  const settle = async () => {
    do { await Promise.allSettled([...pending]); await new Promise(resolve => setTimeout(resolve, 0)) } while (pending.size)
  }
  return { settle, dispose: async () => { await settle(); binding.mockRestore(); await rm(directory, { recursive: true, force: true }) } }
}
