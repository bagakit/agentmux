import type { NoteCreationReceipt } from './note-creation'
import { EMPTY_LAUNCHER_NAMES, type LauncherNames, type LauncherNameField } from './launcher-name-draft'
import { EMPTY_LAUNCHER_OPTIONS, updateLauncherOption, type LauncherProviderOptions } from './launcher-option-draft'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

export type LauncherSection = 'agents' | 'terminal' | 'browser' | 'note'
export type LauncherSectionMode = 'expanded' | 'collapsed' | 'hidden'
export const DEFAULT_LAUNCHER_SECTIONS: Record<LauncherSection, LauncherSectionMode> = {
  agents: 'expanded', terminal: 'expanded', browser: 'collapsed', note: 'collapsed'
}
export type MoteIdeaDraft = { direction: string; includeDiscussion: boolean; feedback: Record<string, { vote: '' | 'useful' | 'less-useful'; comment: string }> }
export type LauncherDraft = { browser: string; note: string; noteCreation?: NoteCreationReceipt; moteIdea?: MoteIdeaDraft;
  prompt?: string; names?: LauncherNames; optionsByProvider?: LauncherProviderOptions }
export const EMPTY_LAUNCHER_DRAFT: LauncherDraft = { browser: '', note: '' }

type LauncherState = {
  persistenceIssue: string | null
  sections: Record<string, Partial<Record<LauncherSection, LauncherSectionMode>>>
  drafts: Record<string, LauncherDraft>
  executors: Record<string, string>
  moteTopicId: string | null
  setSection(workspaceId: string, section: LauncherSection, mode: LauncherSectionMode): boolean
  setDraft(launcherId: string, field: 'browser' | 'note' | 'prompt', value: string): boolean
  setMoteIdeaDraft(launcherId: string, value: MoteIdeaDraft): boolean
  setAgentName(launcherId: string, field: LauncherNameField, value: string): boolean
  setAgentOption(launcherId: string, providerId: string, optionId: string, choiceId: string | null): boolean
  copyUtilityDraft(fromLauncherId: string, toLauncherId: string): boolean
  clearAgentInputsIfUnchanged(launcherId: string, submitted: Pick<LauncherDraft, 'prompt' | 'names' | 'optionsByProvider'>): boolean
  setNoteCreation(launcherId: string, receipt: NoteCreationReceipt): boolean
  selectExecutor(workspaceId: string, executorId: string): boolean
  selectMote(topicId: string): boolean
}

// Presentation, unmaterialized Group inputs and unsent utility drafts. Runtime, Session, Tab and warm PTY ownership stay in
// their existing stores. A failed storage write preserves the in-memory input and is reported by the UI.
let storageReadConfirmed = false
let reportStorageIssue: (message: string) => void = () => {}
export const useLauncherState = create<LauncherState>()(persist((set) => {
  reportStorageIssue = message => { try { set({ persistenceIssue: storageReadConfirmed ? message : 'Saved Launcher preferences could not be read. Current input remains available; existing storage was not cleared.' }) } catch { /* The in-memory warning is already retained. */ } }
  return {
  persistenceIssue: null, sections: {}, drafts: {}, executors: {}, moteTopicId: null,
  setSection(workspaceId, section, mode) {
    try { set(state => ({ persistenceIssue: null, sections: { ...state.sections, [workspaceId]: { ...state.sections[workspaceId], [section]: mode } } })); return true }
    catch { reportStorageIssue('Launcher changes could not be saved. Current input remains available.'); return false }
  },
  setDraft(launcherId, field, value) {
    try { set(state => ({ persistenceIssue: null, drafts: { ...state.drafts, [launcherId]: { ...(state.drafts[launcherId] ?? EMPTY_LAUNCHER_DRAFT), [field]: value } } })); return true }
    catch { reportStorageIssue('Launcher changes could not be saved. Current input remains available.'); return false }
  },
  setMoteIdeaDraft(launcherId, value) {
    try { set(state => ({ persistenceIssue: null, drafts: { ...state.drafts, [launcherId]: { ...(state.drafts[launcherId] ?? EMPTY_LAUNCHER_DRAFT), moteIdea: value } } })); return true }
    catch { reportStorageIssue('Idea inputs could not be saved. Current input remains available.'); return false }
  },
  setNoteCreation(launcherId, receipt) {
    try { set(state => {
      const drafts = { ...state.drafts, [launcherId]: { ...(state.drafts[launcherId] ?? EMPTY_LAUNCHER_DRAFT), noteCreation: receipt } }
      // A Group's in-flight Note keeps its captured target after its Launcher obtains a Region.
      // Every retained view of this exact intent observes its late receipt and same-Note retry.
      for (const [id, draft] of Object.entries(state.drafts)) {
        if (id !== launcherId && draft.noteCreation?.intentId === receipt.intentId) drafts[id] = { ...draft, noteCreation: receipt }
      }
      return { drafts }
    }); return true }
    catch { reportStorageIssue('The Note creation receipt could not be saved. Its exact target and current draft remain in memory.'); return false }
  },
  setAgentName(launcherId, field, value) {
    try { set(state => {
      const draft = state.drafts[launcherId] ?? EMPTY_LAUNCHER_DRAFT
      const names = draft.names ?? EMPTY_LAUNCHER_NAMES
      return names[field] === value ? state : { persistenceIssue: null, drafts: { ...state.drafts,
        [launcherId]: { ...draft, names: { ...names, [field]: value } } } }
    }); return true }
    catch { reportStorageIssue('Launcher changes could not be saved. Current input remains available.'); return false }
  },
  setAgentOption(launcherId, providerId, optionId, choiceId) {
    try { set(state => {
      const draft = state.drafts[launcherId] ?? EMPTY_LAUNCHER_DRAFT
      const current = draft.optionsByProvider ?? EMPTY_LAUNCHER_OPTIONS
      const next = updateLauncherOption(current, providerId, optionId, choiceId)
      return next === current ? state : { persistenceIssue: null, drafts: { ...state.drafts,
        [launcherId]: { ...draft, optionsByProvider: next } } }
    }); return true }
    catch { reportStorageIssue('Launcher changes could not be saved. Current input remains available.'); return false }
  },
  copyUtilityDraft(fromLauncherId, toLauncherId) {
    try { set(state => {
      const draft = state.drafts[fromLauncherId]
      return !draft || fromLauncherId === toLauncherId ? state : { drafts: { ...state.drafts,
        [toLauncherId]: { browser: draft.browser, note: draft.note, ...(draft.noteCreation ? { noteCreation: draft.noteCreation } : {}) } } }
    }); return true }
    catch { reportStorageIssue('Launcher changes could not be saved. Current input remains available.'); return false }
  },
  clearAgentInputsIfUnchanged(launcherId, submitted) {
    try { set(state => {
      const original = state.drafts[launcherId]
      if (!original) return state
      const draft = { ...original }
      if ((original.prompt ?? '') === submitted.prompt) delete draft.prompt
      if ((original.names ?? EMPTY_LAUNCHER_NAMES) === submitted.names) delete draft.names
      if ((original.optionsByProvider ?? EMPTY_LAUNCHER_OPTIONS) === submitted.optionsByProvider) delete draft.optionsByProvider
      return { drafts: { ...state.drafts, [launcherId]: draft } }
    }); return true }
    catch { reportStorageIssue('Launcher changes could not be saved. Current input remains available.'); return false }
  },
  selectExecutor(workspaceId, executorId) {
    try { set(state => ({ persistenceIssue: null, executors: { ...state.executors, [workspaceId]: executorId } })); return true }
    catch { reportStorageIssue('Launcher changes could not be saved. Current input remains available.'); return false }
  },
  selectMote(topicId) {
    try { set({ persistenceIssue: null, moteTopicId: topicId }); return true }
    catch { reportStorageIssue('The selected Mote could not be saved. This Launcher keeps your choice.'); return false }
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
  partialize: state => ({ sections: state.sections, drafts: state.drafts, executors: state.executors, moteTopicId: state.moteTopicId })
}))
