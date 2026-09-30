import type { NoteCreationReceipt } from './note-creation'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

export type LauncherSection = 'agents' | 'terminal' | 'browser' | 'note'
export type LauncherSectionMode = 'expanded' | 'collapsed' | 'hidden'
export const DEFAULT_LAUNCHER_SECTIONS: Record<LauncherSection, LauncherSectionMode> = {
  agents: 'collapsed', terminal: 'expanded', browser: 'collapsed', note: 'collapsed'
}
export type LauncherDraft = { browser: string; note: string; noteCreation?: NoteCreationReceipt }
export const EMPTY_LAUNCHER_DRAFT: LauncherDraft = { browser: '', note: '' }

type LauncherState = {
  persistenceIssue: string | null
  sections: Record<string, Partial<Record<LauncherSection, LauncherSectionMode>>>
  drafts: Record<string, LauncherDraft>
  executors: Record<string, string>
  setSection(workspaceId: string, section: LauncherSection, mode: LauncherSectionMode): boolean
  setDraft(launcherId: string, field: 'browser' | 'note', value: string): boolean
  setNoteCreation(launcherId: string, receipt: NoteCreationReceipt): boolean
  selectExecutor(workspaceId: string, executorId: string): boolean
}

// Presentation and unsent utility drafts only. Runtime, Session, Tab and warm PTY ownership stay in
// their existing stores. A failed storage write preserves the in-memory input and is reported by the UI.
let storageReadConfirmed = false
let reportStorageIssue: (message: string) => void = () => {}
export const useLauncherState = create<LauncherState>()(persist((set) => {
  reportStorageIssue = message => { try { set({ persistenceIssue: storageReadConfirmed ? message : 'Saved Launcher preferences could not be read. Current input remains available; existing storage was not cleared.' }) } catch { /* The in-memory warning is already retained. */ } }
  return {
  persistenceIssue: null, sections: {}, drafts: {}, executors: {},
  setSection(workspaceId, section, mode) {
    try { set(state => ({ persistenceIssue: null, sections: { ...state.sections, [workspaceId]: { ...state.sections[workspaceId], [section]: mode } } })); return true }
    catch { reportStorageIssue('Launcher changes could not be saved. Current input remains available.'); return false }
  },
  setDraft(launcherId, field, value) {
    try { set(state => ({ persistenceIssue: null, drafts: { ...state.drafts, [launcherId]: { ...(state.drafts[launcherId] ?? EMPTY_LAUNCHER_DRAFT), [field]: value } } })); return true }
    catch { reportStorageIssue('Launcher changes could not be saved. Current input remains available.'); return false }
  },
  setNoteCreation(launcherId, receipt) {
    try { set(state => ({ drafts: { ...state.drafts, [launcherId]: { ...(state.drafts[launcherId] ?? EMPTY_LAUNCHER_DRAFT), noteCreation: receipt } } })); return true }
    catch { reportStorageIssue('The Note creation receipt could not be saved. Its exact target and current draft remain in memory.'); return false }
  },
  selectExecutor(workspaceId, executorId) {
    try { set(state => ({ persistenceIssue: null, executors: { ...state.executors, [workspaceId]: executorId } })); return true }
    catch { reportStorageIssue('Launcher changes could not be saved. Current input remains available.'); return false }
  }
}
}, {
  name: 'agentmux-launcher',
  storage: createJSONStorage(() => ({
    // Access storage inside each operation: createJSONStorage must never swallow an unavailable getter.
    getItem: key => typeof window === 'undefined' ? null : window.localStorage.getItem(key),
    setItem: (key, value) => {
      // Reading failure must never let an in-memory default overwrite the only durable record.
      if (!storageReadConfirmed) throw new Error('Saved Launcher state has not been read successfully')
      if (typeof window !== 'undefined') window.localStorage.setItem(key, value)
    },
    removeItem: key => { if (typeof window !== 'undefined') window.localStorage.removeItem(key) }
  })),
  onRehydrateStorage: () => { storageReadConfirmed = false; return (_state, error) => {
    if (error) reportStorageIssue('Saved Launcher preferences could not be read. Current input remains available; existing storage was not cleared.')
    else storageReadConfirmed = true
  } },
  partialize: state => ({ sections: state.sections, drafts: state.drafts, executors: state.executors })
}))
