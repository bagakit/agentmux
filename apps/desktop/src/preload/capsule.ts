import { contextBridge, ipcRenderer } from 'electron'
import { mintObjectId } from '@agentmux/core/object-id'
import type { CapsuleDocumentAction, CapsulePageSdk, CapsulePageTheme } from '../shared/capsule-document.js'
import { unwrapSessionInputOperationResult } from '../shared/session-input-result.js'

// Only this versioned page facade is bridged. Main admits the exact original Browser document
// on every call; a same-origin iframe, popup or later navigation gains no authority from this file.
if (process.isMainFrame) {
  const call = async <T>(action: CapsuleDocumentAction, params: Record<string, unknown> = {}): Promise<T> =>
    unwrapSessionInputOperationResult(await ipcRenderer.invoke('capsule:document', action, params))
  const mutate = async <T>(action: CapsuleDocumentAction, params: Record<string, unknown>, operationId: string): Promise<T> => {
    if (typeof operationId !== 'string' || !operationId.trim())
      throw new Error('Retain an ID from createOperationId() before calling a Capsule mutation.')
    return await call<T>(action, { ...params, operationId })
  }
  const listeners = new Set<(theme: CapsulePageTheme | null) => void>()
  const projected = new Map<string, { before: string; after: string }>()
  let currentTheme: CapsulePageTheme | null = null
  let themeGeneration = 0
  const applyTheme = (): void => {
    const root = document.documentElement
    if (!root) return
    for (const [property, value] of projected) {
      if (root.style.getPropertyValue(property) === value.after) {
        if (value.before) root.style.setProperty(property, value.before)
        else root.style.removeProperty(property)
      }
    }
    projected.clear()
    if (!currentTheme) return
    for (const [property, value] of Object.entries({ ...currentTheme.tokens, 'color-scheme': currentTheme.mode })) {
      if (property !== 'color-scheme' && !/^--[a-zA-Z0-9_-]+$/u.test(property)) continue
      const before = root.style.getPropertyValue(property)
      root.style.setProperty(property, value)
      projected.set(property, { before, after: root.style.getPropertyValue(property) })
    }
  }
  const acceptTheme = (theme: CapsulePageTheme | null): void => {
    currentTheme = theme
    applyTheme()
  }
  const sdk: CapsulePageSdk = {
    createOperationId: mintObjectId,
    capabilities: () => call('capabilities'),
    theme: async () => {
      const generation = themeGeneration
      const theme = await call<CapsulePageTheme | null>('theme')
      if (generation === themeGeneration) acceptTheme(theme)
      return theme
    },
    onThemeChanged(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    request: (question, draft, operationId) => mutate('request', { question, ...(draft === undefined ? {} : { draft }) }, operationId),
    read: interactionId => call('read', { interactionId }),
    saveDraft: (interactionId, expectedRevision, draft, operationId) =>
      mutate('saveDraft', { interactionId, expectedRevision, draft }, operationId),
    inspectOperation: operationId => call('inspectOperation', { operationId })
  }
  ipcRenderer.on('capsule:theme', (_event, theme: CapsulePageTheme | null) => {
    themeGeneration++
    acceptTheme(theme)
    for (const listener of listeners) {
      try { listener(theme) } catch { /* One page callback cannot suppress another listener or its original content. */ }
    }
  })
  document.addEventListener('DOMContentLoaded', applyTheme, { once: true })
  contextBridge.exposeInMainWorld('capsule', sdk)
  void sdk.theme().catch(() => { /* Optional App appearance failure leaves the original page readable. */ })
}
