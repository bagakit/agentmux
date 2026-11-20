import { create } from 'zustand'

export const useAppStore = create<any>(() => ({
  config: null, loading: false, sessions: [], noticeReadReceipts: {}, tabs: {}, layouts: {}, viewModes: {}, agentComposerDrafts: {},
  mailboxNotificationIntents: {}, mailboxNotificationFeedback: {}, mailboxNotificationHistory: {},
  selectSession: () => true
}))

export function currentCoreSpatialGraph() { return null }
export function fileNavigationSelection() { return '' }
export function compareAndSwapCapsuleQuestionEditor() { return false }
export function flushCapsuleQuestionEditors() { return [] }
export function retainMailboxNotificationIntent() {}
