import { useCallback, useSyncExternalStore, type ReactNode } from 'react'
import { ComposerHost } from '@agentmux/client-ui/components/ComposerHost'
import type { MoteDefaultConversation } from '@agentmux/core/mote-preferences'
import { useAppStore } from '../store'
import { useLauncherState } from '../lib/launcher-state'
import { moteEntryDraftKey } from '../lib/mote-entry-hold'
import type { MoteWorkfaceScope } from '../lib/mote-workface'

export function moteComposerSessionKey(reference: MoteDefaultConversation, roleRevision: string | null | undefined): string {
  return JSON.stringify(['session', reference, roleRevision ?? null])
}

/** Subscribe only the selected Mote input, not every hidden Session composer. */
export function useMoteComposerText(key: string | null): string {
  const subscribe = useCallback((changed: () => void) => key ? useLauncherState.subscribe((next, previous) => {
    if (next.drafts[key]?.prompt !== previous.drafts[key]?.prompt) changed()
  }) : () => {}, [key])
  const read = useCallback(() => key ? useLauncherState.getState().drafts[key]?.prompt ?? '' : '', [key])
  return useSyncExternalStore(subscribe, read, read)
}

/** Existing Launcher persistence owns this text before and after a Main is loaded. */
export function DesktopMoteComposerHost({ scope, sourceKey, reference, active, onHold, children }: {
  scope: MoteWorkfaceScope; sourceKey: string; reference?: MoteDefaultConversation | null | undefined; active: boolean; onHold?: (() => void) | undefined; children: ReactNode
}) {
  const key = moteEntryDraftKey(scope), value = useMoteComposerText(key)
  const onChange = useCallback((text: string) => { useAppStore.getState().setAgentComposerDraft(reference?.sessionId ?? null, text, key) }, [key, reference?.sessionId])
  return <ComposerHost ownerKey={key} sourceKey={sourceKey} value={value} onChange={onChange} active={active}
    unbound={{ disabled: false, placeholder: '写下你想聊的事…', ...(onHold && value.trim() ? { onSubmit: onHold } : {}) }}>
    {children}
  </ComposerHost>
}
