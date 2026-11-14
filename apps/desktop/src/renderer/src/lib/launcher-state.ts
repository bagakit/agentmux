import type { NoteCreationReceipt } from './note-creation'
import type { ScheduleDraft } from './schedule-draft'
import type { MoteIdeaSchedulePreparation } from './mote-idea-request'
import { EMPTY_LAUNCHER_NAMES, type LauncherNames, type LauncherNameField } from './launcher-name-draft'
import { EMPTY_LAUNCHER_OPTIONS, updateLauncherOption, type LauncherProviderOptions } from './launcher-option-draft'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { desktopUserFragments } from './desktop-user-state'
import type { SplitDirection } from '@agentmux/layout'
import { launcherSourceExecution } from './launcher-source'

export type LauncherSection = 'agents' | 'terminal' | 'browser' | 'note'
export type LauncherSectionMode = 'expanded' | 'collapsed' | 'hidden'
export const DEFAULT_LAUNCHER_SECTIONS: Record<LauncherSection, LauncherSectionMode> = {
  agents: 'expanded', terminal: 'expanded', browser: 'collapsed', note: 'collapsed'
}
export type MoteIdeaDraft = { direction: string; includeDiscussion: boolean; feedback: Record<string, { vote: '' | 'useful' | 'less-useful'; comment: string }>; arrangement?: MoteIdeaSchedulePreparation }
export type MoteProfileDraft = { source: import('@agentmux/core').FileDocument; name: string; body: string }
export type QueuedDraftMove = { operationId: string; sessionId: string; runId: string; text: string; body: string }
export type LauncherDraft = { browser: string; note: string; noteCreation?: NoteCreationReceipt; moteIdea?: MoteIdeaDraft; schedule?: ScheduleDraft;
  moteProfile?: MoteProfileDraft | undefined;
  progressUpdate?: import('../../../shared/continuous-progress').ProgressUpdateRequest | undefined;
  progressDraft?: { interval: string; prompt: string; expectedLoop?: import('@agentmux/core').ContinuousProgressLoop | undefined } | undefined;
  unconfirmedProgressUpdates?: import('../../../shared/continuous-progress').ProgressUpdateRequest[];
  /** Cross-owner custody until this exact queue archive and destination draft both have storage ACKs. */
  queuedInputMoves?: Record<string, QueuedDraftMove> | undefined
  prompt?: string; names?: LauncherNames; optionsByProvider?: LauncherProviderOptions
  /** Exact Source selection shares this original private draft; future values remain opaque. */
  sourceExecution?: unknown
  /** Browser-owned unsent creation options share this existing utility-draft persistence owner. */
  browserAgent?: { executorId?: string; split?: SplitDirection; hostId?: string }
  /** A Mote message sent while its Main was read. It stays on this device until delivered; a reopened view returns it to the prompt. */
  heldPrompt?: { operationId: string; prompt: string; holder: string } | undefined }
export const EMPTY_LAUNCHER_DRAFT: LauncherDraft = { browser: '', note: '' }

type LauncherState = {
  persistenceIssue: string | null
  sections: Record<string, Partial<Record<LauncherSection, LauncherSectionMode>>>
  drafts: Record<string, LauncherDraft>
  executors: Record<string, string>
  moteTopicId: string | null
  setSection(workspaceId: string, section: LauncherSection, mode: LauncherSectionMode): boolean
  setDraft(launcherId: string, field: 'browser' | 'note' | 'prompt', value: string): boolean
  retainQueuedInputInDraft(launcherId: string, source: QueuedDraftMove): boolean
  clearQueuedInputMove(launcherId: string, source: QueuedDraftMove): boolean
  setBrowserAgentDraft(launcherId: string, patch: { prompt?: string; executorId?: string; split?: SplitDirection; hostId?: string }): boolean
  /** Move the prompt into a held Mote message in one saved write. */
  holdPrompt(launcherId: string, operationId: string, holder: string): boolean
  /** End this exact held message: a delivered one is dropped; an undelivered one returns before any newer typing. */
  settleHeldPrompt(launcherId: string, operationId: string, delivered: boolean): boolean
  setMoteIdeaDraft(launcherId: string, value: MoteIdeaDraft): boolean
  setMoteProfileDraft(launcherId: string, value: MoteProfileDraft | undefined): boolean
  setScheduleDraft(launcherId: string, patch: Partial<ScheduleDraft>): boolean
  setProgressUpdate(launcherId: string, request: import('../../../shared/continuous-progress').ProgressUpdateRequest | undefined): boolean
  setProgressDraft(launcherId: string, patch: Partial<NonNullable<LauncherDraft['progressDraft']>> | undefined): boolean
  retainProgressUpdate(launcherId: string): boolean
  setAgentName(launcherId: string, field: LauncherNameField, value: string): boolean
  setSourceExecution(launcherId: string, value: import('./launcher-source').LauncherSourceExecution | undefined): boolean
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
const unreadUpdates: ((state: LauncherState) => Partial<LauncherState>)[] = []
export const useLauncherState = create<LauncherState>()(persist((save) => {
  const set: typeof save = (update, replace) => {
    if (!storageReadConfirmed) unreadUpdates.push(typeof update === 'function' ? update : () => update)
    return save(update, replace as false)
  }
  reportStorageIssue = message => { try { save({ persistenceIssue: storageReadConfirmed ? message : 'Saved Launcher preferences could not be read. Current input remains available; existing storage was not cleared.' }) } catch { /* The in-memory warning is already retained. */ } }
  return {
  persistenceIssue: null, sections: {}, drafts: {}, executors: {}, moteTopicId: null,
  setSourceExecution(launcherId, value) {
    try { set(state => {
      const draft = state.drafts[launcherId] ?? EMPTY_LAUNCHER_DRAFT
      launcherSourceExecution(draft.sourceExecution)
      return { persistenceIssue: null, drafts: { ...state.drafts, [launcherId]: { ...draft, sourceExecution: value } } }
    }); return true }
    catch { reportStorageIssue('The original project and Agent selection could not be saved. Your current draft is retained.'); return false }
  },
  setMoteProfileDraft(launcherId, value) {
    try { set(state => ({ persistenceIssue: null, drafts: { ...state.drafts, [launcherId]: { ...(state.drafts[launcherId] ?? EMPTY_LAUNCHER_DRAFT), moteProfile: value } } })); return true }
    catch { reportStorageIssue('Your profile draft could not be saved on this device. Current input remains available.'); return false }
  },
  setProgressUpdate(launcherId, request) {
    try { set(state => ({ persistenceIssue: null, drafts: { ...state.drafts, [launcherId]: { ...(state.drafts[launcherId] ?? EMPTY_LAUNCHER_DRAFT), progressUpdate: request } } })); return true }
    catch { reportStorageIssue('The original configuration request could not be saved. Your current input is kept.'); return false }
  },
  setProgressDraft(launcherId, patch) {
    try { set(state => ({ persistenceIssue: null, drafts: { ...state.drafts, [launcherId]: { ...(state.drafts[launcherId] ?? EMPTY_LAUNCHER_DRAFT),
      progressDraft: patch ? { interval: '', prompt: '', ...state.drafts[launcherId]?.progressDraft, ...patch } : undefined } } })); return true }
    catch { reportStorageIssue('Your configuration draft could not be saved on this device. Current input remains available.'); return false }
  },
  retainProgressUpdate(launcherId) {
    try { set(state => {
      const draft = state.drafts[launcherId], request = draft?.progressUpdate
      return !request ? state : { drafts: { ...state.drafts, [launcherId]: { ...draft, progressUpdate: undefined,
        unconfirmedProgressUpdates: [...(draft.unconfirmedProgressUpdates ?? []), request] } } }
    }); return true }
    catch { reportStorageIssue('The original unconfirmed save remains available; its local persistence is unconfirmed.'); return false }
  },
  setScheduleDraft(launcherId, patch) {
    try { set(state => ({ persistenceIssue: null, drafts: { ...state.drafts, [launcherId]: { ...(state.drafts[launcherId] ?? EMPTY_LAUNCHER_DRAFT),
      schedule: { ...state.drafts[launcherId]?.schedule, ...patch } } } })); return true }
    catch { reportStorageIssue('Arrangement input could not be saved. Current input and original request remain available.'); return false }
  },
  setSection(workspaceId, section, mode) {
    try { set(state => ({ persistenceIssue: null, sections: { ...state.sections, [workspaceId]: { ...state.sections[workspaceId], [section]: mode } } })); return true }
    catch { reportStorageIssue('Launcher changes could not be saved. Current input remains available.'); return false }
  },
  setDraft(launcherId, field, value) {
    try { set(state => ({ persistenceIssue: null, drafts: { ...state.drafts, [launcherId]: { ...(state.drafts[launcherId] ?? EMPTY_LAUNCHER_DRAFT), [field]: value } } })); return true }
    catch { reportStorageIssue('Launcher changes could not be saved. Current input remains available.'); return false }
  },
  retainQueuedInputInDraft(launcherId, source) {
    try { set(state => {
      const draft = state.drafts[launcherId] ?? EMPTY_LAUNCHER_DRAFT, previous = draft.queuedInputMoves?.[source.operationId]
      if (previous) {
        if (JSON.stringify(previous) !== JSON.stringify(source)) throw new Error('The original queued input changed. Both original bodies are kept.')
        return state
      }
      return { persistenceIssue: null, drafts: { ...state.drafts, [launcherId]: { ...draft,
        prompt: `${draft.prompt ?? ''}${draft.prompt ? '\n\n' : ''}${source.body}`,
        queuedInputMoves: { ...draft.queuedInputMoves, [source.operationId]: source } } } }
    }); return true }
    catch { reportStorageIssue('The original queued input and draft are kept; saving this move is unconfirmed.'); return false }
  },
  clearQueuedInputMove(launcherId, source) {
    try { set(state => {
      const draft = state.drafts[launcherId]
      if (!draft || JSON.stringify(draft.queuedInputMoves?.[source.operationId]) !== JSON.stringify(source)) return state
      const { [source.operationId]: _confirmed, ...remaining } = draft.queuedInputMoves!
      return { drafts: { ...state.drafts, [launcherId]: { ...draft, queuedInputMoves: Object.keys(remaining).length ? remaining : undefined } } }
    }); return true }
    catch { reportStorageIssue('The original move is confirmed; its local custody receipt is kept until saving is confirmed.'); return false }
  },
  setBrowserAgentDraft(launcherId, { prompt, ...options }) {
    try { set(state => {
      const draft = state.drafts[launcherId] ?? EMPTY_LAUNCHER_DRAFT
      return { persistenceIssue: null, drafts: { ...state.drafts, [launcherId]: { ...draft, ...(prompt === undefined ? {} : { prompt }),
        browserAgent: { ...draft.browserAgent, ...options } } } }
    }); return true }
    catch { reportStorageIssue('Launcher changes could not be saved. Current input remains available.'); return false }
  },
  holdPrompt(launcherId, operationId, holder) {
    try { set(state => {
      const draft = state.drafts[launcherId] ?? EMPTY_LAUNCHER_DRAFT
      if (draft.heldPrompt || !draft.prompt?.trim()) return state
      return { persistenceIssue: null, drafts: { ...state.drafts, [launcherId]: { ...draft, prompt: '', heldPrompt: { operationId, prompt: draft.prompt, holder } } } }
    }); return true }
    catch { reportStorageIssue('Launcher changes could not be saved. Current input remains available.'); return false }
  },
  settleHeldPrompt(launcherId, operationId, delivered) {
    try { set(state => {
      const draft = state.drafts[launcherId], held = draft?.heldPrompt
      if (!held || held.operationId !== operationId) return state
      const prompt = delivered ? draft.prompt ?? '' : [held.prompt, draft.prompt ?? ''].filter(value => value.trim()).join('\n\n')
      return { persistenceIssue: null, drafts: { ...state.drafts, [launcherId]: { ...draft, prompt, heldPrompt: undefined } } }
    }); return true }
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
        [toLauncherId]: { browser: draft.browser, note: draft.note, ...(draft.noteCreation ? { noteCreation: draft.noteCreation } : {}),
          ...(draft.sourceExecution === undefined ? {} : { sourceExecution: draft.sourceExecution }) } } }
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
  skipHydration: !__AGENTMUX_WEB_PREVIEW__,
  storage: createJSONStorage(() => ({
    getItem: () => desktopUserFragments.read('launcher'),
    setItem: (_key, value) => {
      if (!storageReadConfirmed) throw new Error('Saved Launcher state has not been read successfully')
      desktopUserFragments.write('launcher', value)
    },
    removeItem: () => desktopUserFragments.write('launcher', null)
  })),
  merge: (persisted, current) => {
    let restored = { ...current, ...persisted as Partial<LauncherState> }
    for (const update of unreadUpdates) restored = { ...restored, ...update(restored) }
    return restored
  },
  onRehydrateStorage: () => { storageReadConfirmed = false; return (_state, error) => {
    if (error) reportStorageIssue('Saved Launcher preferences could not be read. Current input remains available; existing storage was not cleared.')
    else {
      storageReadConfirmed = true
      // Replayed input must reach the same document cache before its unread
      // overlay is released; a root-only checkpoint must include these edits.
      if (unreadUpdates.length && _state) desktopUserFragments.write('launcher', JSON.stringify({ state: {
        sections: _state.sections, drafts: _state.drafts, executors: _state.executors, moteTopicId: _state.moteTopicId
      }, version: 0 }))
      unreadUpdates.length = 0
    }
  } },
  partialize: state => ({ sections: state.sections, drafts: state.drafts, executors: state.executors, moteTopicId: state.moteTopicId })
}))


/** Root hydration and explicit retries preserve edits made while original bytes were unknown. */
let launcherHydration: Promise<void> | null = null
export async function initializeLauncherState(): Promise<void> {
  if (storageReadConfirmed) return
  if (launcherHydration) return await launcherHydration
  const work = (async () => { try {
    await desktopUserFragments.load('launcher', raw => {
      if (raw === null) return
      const value = JSON.parse(raw)
      if (!value || typeof value !== 'object' || !value.state || typeof value.state !== 'object' || Array.isArray(value.state) ||
        typeof value.version !== 'number') throw new Error('Saved Launcher input is invalid. Original bytes are retained.')
    })
    await useLauncherState.persist.rehydrate()
    if (!storageReadConfirmed) throw new Error('Saved Launcher input could not be restored.')
  } catch (error) { reportStorageIssue('Saved Launcher input is unconfirmed. Current input and original requests remain available.'); throw error } })()
  launcherHydration = work
  try { await work } finally { if (launcherHydration === work) launcherHydration = null }
}

/** Memory setters do not acknowledge disk. Call this before their dependent business action. */
export async function checkpointLauncherState(): Promise<void> {
  await initializeLauncherState()
  const state = useLauncherState.getState()
  desktopUserFragments.write('launcher', JSON.stringify({ state: { sections: state.sections, drafts: state.drafts,
    executors: state.executors, moteTopicId: state.moteTopicId }, version: 0 }))
  await desktopUserFragments.checkpoint('launcher')
}

export const launcherUnreadEditsPending = () => unreadUpdates.length > 0
