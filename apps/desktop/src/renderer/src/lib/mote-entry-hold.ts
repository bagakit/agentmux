import { useCallback, useEffect, useRef, useState } from 'react'
import { mintObjectId } from '@agentmux/core/object-id'
import { useLauncherState } from './launcher-state'
import type { MoteWorkfaceScope } from './mote-workface'

/** The welcome and the reading shell edit one Mote draft, so text typed while reading is the welcome's draft. */
export function moteEntryDraftKey(scope: MoteWorkfaceScope): string {
  return 'mote-main-start:' + JSON.stringify([scope.workspace.hostId, scope.workspace.id, scope.workspace.path, scope.topic.id, scope.rootPath])
}

/** A message the person sent before the Main was read. It stays on this device; nothing has been sent. */
export type MoteHeldEntryInput = import('@agentmux/core/mote-dialogue').MoteMainDeferredInput

/** Held messages whose open is still alive in this window; a saved hold from a closed window or reload is not here. */
const liveHolders = new Set<string>()

/**
 * One held message per Mote, saved with that Mote's Launcher draft. Holding moves the prompt out of the Composer so
 * the text appears once; withdrawing or a refused delivery puts it back. The hold belongs to the open that made it:
 * when that open is hidden or closed, the text returns to the draft and is never sent later. Other views of the same
 * Mote (a hidden Space workface, a second panel) only show the draft, never release or send a hold they did not make.
 */
export function useMoteHeldEntryInput(draftKey: string | null, active: boolean) {
  const [holder] = useState(mintObjectId)
  const saved = useLauncherState(state => draftKey ? state.drafts[draftKey]?.heldPrompt ?? null : null)
  const settle = useCallback((operationId: string, delivered = false) => {
    if (draftKey) useLauncherState.getState().settleHeldPrompt(draftKey, operationId, delivered)
  }, [draftKey])
  const hold = useCallback(() => {
    if (!draftKey) return
    liveHolders.add(holder)
    useLauncherState.getState().holdPrompt(draftKey, mintObjectId(), holder)
  }, [draftKey, holder])
  const own = saved?.holder === holder
  const release = useCallback(() => { if (saved && own) settle(saved.operationId) }, [saved, own, settle])
  // This open is hidden or its Mote changed: its own hold returns to the draft.
  const latest = useRef({ saved, own, settle }); latest.current = { saved, own, settle }
  useEffect(() => { if (saved && own && !active) settle(saved.operationId) }, [saved, own, active, settle])
  useEffect(() => () => {
    liveHolders.delete(holder)
    const { saved: last, own: mine, settle: end } = latest.current
    if (last && mine) end(last.operationId)
  }, [draftKey, holder])
  // A hold saved by an open that no longer exists (a reload or another closed window) is returned, not sent.
  useEffect(() => { if (saved && active && !liveHolders.has(saved.holder)) settle(saved.operationId) }, [saved, active, settle])
  return { held: saved && own ? { operationId: saved.operationId, prompt: saved.prompt, ...(saved.focusTask ? { focusTask: saved.focusTask } : {}) } : null, hold, release, settle }
}
