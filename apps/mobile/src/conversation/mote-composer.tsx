import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { ComposerHost, ComposerSource, ComposerSurface } from '@agentmux/client-ui/components/ComposerHost'
import { AgentComposer, type AgentComposerProps } from '@agentmux/client-ui/components/AgentComposer'
import { ClientUiProvider } from '@agentmux/client-ui/platform'
import type { ClientUiPlatform } from '@agentmux/client-ui/platform'
import type { MobileConversationClient } from './mobile-conversation-client'
import type { MotePreferencesTarget } from '@agentmux/core/mote-preferences'
import { deriveObjectId } from '@agentmux/core/object-id'
import { getDeviceWorkface } from '../recovery/device-workface'
import { useMobileLocalDrafts, type MobileLocalDrafts } from './local-drafts-owner'
import { useMobileWebUpdateSafetyOwner } from '../mobile-web/update-safety'

/** A device text address, independent of the Session input/operation address. */
export function mobileMoteStartDraftKey(client: MobileConversationClient | null, target: MotePreferencesTarget) {
  const record = getDeviceWorkface().snapshotIdentity()
  return JSON.stringify(['mote-main-start', deriveObjectId('mobile-mote-main-draft', JSON.stringify([record.host?.origin || location.origin,
    client?.runtimeOwnerIdentity?.()?.runtimeId ?? null, record.host?.hostId ?? null, target.spaceId, target.zoneId,
    target.expectedResource.hostId, target.expectedResource.workspaceId, target.expectedResource.workspacePath]))])
}
/** Text address only, within the original Device/Host record; it grants no input authority. */
export const mobileMoteTextScope = (target: MotePreferencesTarget) => deriveObjectId('mobile-mote-text-source', JSON.stringify([
  target.spaceId, target.zoneId, target.expectedResource.hostId, target.expectedResource.workspaceId, target.expectedResource.workspacePath]))

export type MobileTextDraft = {
  key: string; recordId: string | null; local: MobileLocalDrafts; edits: { current: number }; token: object
  notify(): void; isCurrent(): boolean; bind(): { key: string; expected: string | undefined; next: string }
}
type Binding = { ownerKey: string; sourceKey: string; text: MobileTextDraft; sourceCurrent(key: string): boolean }
const Context = createContext<Binding | null>(null)
export const mobileSessionComposerSource = (sessionId: string | null) => JSON.stringify(['session', sessionId])
export const mobileWelcomeComposerSource = (mode: 'start' | 'new') => JSON.stringify(['welcome', mode])
export function useMobileMoteComposer() { return useContext(Context) }

/** Ordinary Session surfaces own an ordinary Composer; only the Mote publishes into its Host. */
export function MobileComposerSource({ sourceKey, ...props }: AgentComposerProps & { sourceKey: string }) {
  const binding = useMobileMoteComposer()
  return binding ? <ComposerSource {...props} ownerKey={binding.ownerKey} sourceKey={sourceKey} enabled={binding.sourceCurrent(sourceKey)} />
    : <AgentComposer {...props} />
}

/** Fixed input position. The existing Device owner retains text; Sources retain input qualification. */
export function MobileMoteComposer({ client, target, enabled, active, sourceKey, platform, children }: {
  client: MobileConversationClient | null; target: MotePreferencesTarget | undefined; enabled: boolean; active: boolean
  sourceKey: string; platform: ClientUiPlatform; children: ReactNode
}) {
  const local = useMobileLocalDrafts(), [, redraw] = useState(0), device = getDeviceWorkface()
  const address = target ? JSON.stringify(target) : ''
  const current = useRef({ address, sourceKey, enabled, active, client })
  current.current = { address, sourceKey, enabled, active, client }
  // A late Runtime observation or record replacement never substitutes another
  // text map/key under the person's live editor. A different Mote is explicit.
  const text = useMemo<MobileTextDraft | null>(() => {
    if (!target) return null
    const recordId = device.recordIdentity(), scope = mobileMoteTextScope(target)
    const originalBinding = local.moteTextSources.get(scope), key = originalBinding ?? mobileMoteStartDraftKey(client, target)
    const originalHost = JSON.stringify(device.snapshotIdentity().host ?? null)
    let runtimeId = client?.runtimeOwnerIdentity?.()?.runtimeId ?? null
    return { key, recordId, local, edits: { current: 0 }, token: {}, notify: () => redraw(value => value + 1),
      bind() {
        if (!local.moteTextSources.has(scope)) local.moteTextSources.set(scope, key)
        return { key: scope, expected: originalBinding, next: key }
      },
      isCurrent() {
        const now = current.current, runtime = now.client?.runtimeOwnerIdentity?.()?.runtimeId ?? null
        if (!runtimeId && JSON.stringify(device.snapshotIdentity().host ?? null) !== originalHost) return false
        runtimeId ??= runtime
        return now.address === address && device.recordIdentity() === recordId && (!runtimeId || runtimeId === runtime)
      } }
  }, [address])
  useMobileWebUpdateSafetyOwner(() => text?.local.hasUnconfirmedSave || text?.local.saveIssue || text?.local.recordChanged
    ? '原 Mote 草稿尚未确认保存在设备上；请保全后再更新网页。' : null)
  if (!text) return children
  const ownerKey = JSON.stringify(['mobile-mote-composer', address, text.recordId, text.key])
  const sourceCurrent = (key: string) => current.current.enabled && current.current.active && current.current.sourceKey === key && text.isCurrent()
  const draft = text.local.drafts.get(text.key) ?? ''
  const change = (value: string) => {
    const expected = text.local.drafts.get(text.key), binding = value !== expected ? text.bind() : undefined
    if (value !== expected) text.edits.current++
    text.local.drafts.set(text.key, value); text.notify()
    void text.local.saveText(text.key, expected, binding).then(text.notify)
  }
  const selectedSource = enabled && text.isCurrent() ? sourceKey : 'unconfirmed-original-device'
  return <Context.Provider value={enabled ? { ownerKey, sourceKey: selectedSource, text, sourceCurrent } : null}>
    <ComposerHost ownerKey={ownerKey} sourceKey={selectedSource} value={draft} onChange={change} active={active && enabled}
      unbound={{ disabled: false, placeholder: '写下你想聊的事…' }}>
      {children}
      <ClientUiProvider platform={platform}><ComposerSurface className="mobile-mote-composer" /></ClientUiProvider>
      {enabled && (!text.isCurrent() || text.local.notice) && <p role="status" className="mobile-mote-composer-notice">{text.local.notice ?? '原 Mac 或设备工作面已变化；这份草稿仍保留，核对原对话后再发送。'}</p>}
    </ComposerHost>
  </Context.Provider>
}
