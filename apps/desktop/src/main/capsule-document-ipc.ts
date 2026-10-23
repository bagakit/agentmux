import { isDeepStrictEqual } from 'node:util'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { AgentMuxError } from '@agentmux/core'
import type { CapsulePort, CapsuleRecord } from '@agentmux/core/capsule'
import type { BrowserViewManager } from './browser-view-manager.js'
import type { CapsuleDocumentAction, CapsulePageTheme } from '../shared/capsule-document.js'

const fields: Record<CapsuleDocumentAction, readonly string[]> = {
  capabilities: [], theme: [], request: ['question', 'draft', 'operationId'], read: ['interactionId'],
  saveDraft: ['interactionId', 'expectedRevision', 'draft', 'operationId'], inspectOperation: ['operationId']
}
function parameters(action: unknown, value: unknown): { action: CapsuleDocumentAction; params: Record<string, unknown> } {
  if (typeof action !== 'string' || !Object.hasOwn(fields, action) || !value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(key => !fields[action as CapsuleDocumentAction].includes(key)))
    throw new AgentMuxError('This Capsule document requested an unsupported capability or supplied authority fields.', 'CONTROL_PERMISSION_DENIED')
  return { action: action as CapsuleDocumentAction, params: value as Record<string, unknown> }
}

/** This facade accepts only the original native main document, never the App renderer or page claims. */
export function capsuleDocumentIpc(options: {
  browsers: Pick<BrowserViewManager, 'capsuleDocument' | 'capsuleDocumentContents'>
  capsules: CapsulePort
  theme(): CapsulePageTheme
}) {
  const admit = async (sender: WebContents, frame: IpcMainInvokeEvent['senderFrame']) => {
    const binding = options.browsers.capsuleDocument(sender, frame)
    if (!binding) throw new AgentMuxError('This document has no current Capsule capability. The page remains readable.', 'CONTROL_PERMISSION_DENIED')
    const { record, endpoint } = await options.capsules.call('capsule.inspect', { capsuleId: binding.record.capsuleId })
    const current = options.browsers.capsuleDocument(sender, frame)
    if (!current || current.browserId !== binding.browserId || current.navigationId !== binding.navigationId ||
      record.capsuleId !== binding.record.capsuleId || record.mode !== 'injected' ||
      !isDeepStrictEqual(record.target, binding.record.target) || endpoint.status !== 'available' ||
      endpoint.instanceId !== current.instanceId || binding.instanceId !== current.instanceId ||
      new URL(endpoint.url).origin !== new URL(sender.getURL()).origin)
      throw new AgentMuxError('The original Capsule document or its current capability changed. Read the original page; retry only from its current document.', 'CONTROL_PERMISSION_DENIED')
    return record
  }
  const projectedTheme = (record: CapsuleRecord) => record.theme === 'follow' ? options.theme() : null
  return {
    async call(event: IpcMainInvokeEvent, actionValue: unknown, value: unknown) {
      const { action, params } = parameters(actionValue, value)
      const record = await admit(event.sender, event.senderFrame)
      const capsuleId = record.capsuleId
      switch (action) {
        case 'capabilities': return { version: 1, theme: record.theme === 'follow', interaction: true, humanReply: false }
        case 'theme': return projectedTheme(record)
        case 'request': return (await options.capsules.call('capsule.interaction.request', { capsuleId,
          ...params } as never)).interaction
        case 'read': return (await options.capsules.call('capsule.interaction.inspect', { capsuleId,
          ...params } as never)).interaction
        case 'saveDraft': return (await options.capsules.call('capsule.interaction.draft', { capsuleId,
          ...params } as never)).interaction
        case 'inspectOperation': {
          const { operation } = await options.capsules.call('capsule.operation.inspect', params as never)
          if (operation && operation.capsuleId !== capsuleId) throw new AgentMuxError('The original operation belongs to another Capsule.', 'CONTROL_PERMISSION_DENIED')
          return operation
        }
      }
    },
    async pushTheme(browserId: string) {
      const sender = options.browsers.capsuleDocumentContents(browserId)
      if (!sender) return
      try {
        const record = await admit(sender, sender.mainFrame)
        if (options.browsers.capsuleDocumentContents(browserId) === sender) sender.send('capsule:theme', projectedTheme(record))
      } catch {
        // Clear only this optional projection; a lost capability cannot remove page content.
        if (!sender.isDestroyed()) sender.send('capsule:theme', null)
      }
    }
  }
}
