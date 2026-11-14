import { resolveComposerInputConfig, type ComposerInputConfig } from '@agentmux/client-ui/composer-input-config'
import { DEFAULT_THEME_ID } from '@agentmux/client-ui/theme'
import { DEFAULT_APP_ICON } from '@agentmux/client-ui/app-icon-catalog'
import { CONVERSATION_DETAIL_LEVEL_DEFAULT } from '@agentmux/client-ui/conversation-detail-level'
import { resolveConversationShowSendReceipts, resolveConversationConfirmedSendReceipt } from '@agentmux/client-ui/conversation-send-receipts'
import { normalizeAgentContinuityPolicy, type AgentMuxContinuityPolicy } from '@agentmux/core/agent-session-recovery'
import { APP_APPEARANCE_DEFAULT, TERMINAL_FONT_SIZE_DEFAULT, PROJECT_RAIL_DENSITY_DEFAULT, MESSAGE_TOOL_INITIAL_LAYOUT_DEFAULT, MOTE_DIRECTORY_VIEW_DEFAULT, MOTE_DIRECTORY_AVATAR_SIZE_DEFAULT, TOPIC_DIRECTORY_INITIAL_VIEW_DEFAULT, type AppConfig, type GoalsCommonActionsConfig } from './contracts'
import { DEFAULT_NOTIFICATION_MODE_ID, DEFAULT_NOTIFICATION_SOUND } from './notification-presentation'
import { resolveA2ANotifications } from './a2a-preferences'
import { DEFAULT_PERFORMANCE_PREFERENCES, DEFAULT_MOBILE_CONNECTION_PREFERENCES } from './toolkit-preferences'
import { resolveUserProfile, type UserProfile } from '@agentmux/host/mote-model'
import { resolveFocusRecentActivityHours, resolveFocusTopicPresentation, resolveFocusLinkDestination, resolveFocusReplyLines, resolveFocusPreviewTrigger, resolveFocusRecentInputs, resolveFocusMapMotion, resolveFocusSelectionFillPercent, resolveFocusSelectionBorderPercent, resolveFocusSelectionAccent } from './focus-preferences'
import { resolveFocusMapPreferences, type FocusMapPreferences } from './focus-map-preferences'
import { resolveGoalsCommonActions, resolveGoalsPreferences, type GoalsPreferences } from '@agentmux/host/goals-preferences'
import { resolveNotesPreferences, type NotesPreferences } from './notes-preferences'
import { resolveMarkdownPreferences, type MarkdownPreferences } from './markdown-preferences'
import { resolveBrowserStartPage, type BrowserStartPageConfig } from './browser-start-page'
import { resolveSurveyThumbnailLayout, type SurveyThumbnailLayout } from './survey-thumbnail-layout'
import { BROWSER_NEW_PAGE_SCENES, resolveBrowserNewPagePlacement, type BrowserNewPagePlacement } from './browser-new-page-placement'
import { resolveBrowserAgentControl, type BrowserAgentControlPreferences } from './browser-agent-control'
import { resolveAutomationPreferences, type AutomationPreferences } from './automation-preferences'

export function configValuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => configValuesEqual(value, b[index]))
  }
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && configValuesEqual(left[key], right[key]))
}

type PreferenceDomain = {
  resolve(value: unknown): unknown
  // Complete values have required fields; authored domains keep absent optional fields absent.
  merge?: 'authored' | 'resolved'
  fields?: Record<string, (value: unknown) => unknown>
  field?: (key: string, value: unknown, fallback: unknown) => unknown
}

const preferenceDomains = new Map<string, PreferenceDomain>(Object.entries({
  a2a: { resolve: value => ({ notifications: resolveA2ANotifications({ a2a: value as AppConfig['a2a'] }) }), merge: 'authored' },
  automation: { resolve: value => resolveAutomationPreferences(value as AutomationPreferences | undefined), merge: 'authored' },
  'browser.agentControl': { resolve: value => resolveBrowserAgentControl(value as Partial<BrowserAgentControlPreferences> | undefined), merge: 'authored' },
  'browser.startPage': { resolve: value => resolveBrowserStartPage(value as Partial<BrowserStartPageConfig> | undefined), merge: 'authored' },
  'browser.surveyThumbnails': { resolve: value => resolveSurveyThumbnailLayout(value as Partial<SurveyThumbnailLayout> | undefined), merge: 'authored' },
  'browser.newPagePlacement': { resolve: value => Object.fromEntries(BROWSER_NEW_PAGE_SCENES.map(scene => [scene, resolveBrowserNewPagePlacement(value as Partial<BrowserNewPagePlacement> | undefined, scene)])), merge: 'authored' },
  continuity: { resolve: value => normalizeAgentContinuityPolicy(value as Partial<AgentMuxContinuityPolicy> | undefined), merge: 'authored' },
  profile: { resolve: value => resolveUserProfile(value as Partial<UserProfile> | undefined), merge: 'resolved' },
  focus: { resolve: value => value ?? { recentActivityHours: resolveFocusRecentActivityHours(undefined) }, merge: 'resolved', fields: {
    recentActivityHours: resolveFocusRecentActivityHours, topicPresentation: resolveFocusTopicPresentation,
    linkDestination: resolveFocusLinkDestination, replyLines: resolveFocusReplyLines, previewTrigger: resolveFocusPreviewTrigger,
    recentInputs: resolveFocusRecentInputs, mapMotion: resolveFocusMapMotion, selectionFillPercent: resolveFocusSelectionFillPercent,
    selectionBorderPercent: resolveFocusSelectionBorderPercent, selectionAccent: resolveFocusSelectionAccent, projects: value => value ?? [], zonePresentations: value => value ?? []
  } },
  'focus.map': { resolve: value => resolveFocusMapPreferences(value as FocusMapPreferences | undefined), merge: 'resolved' },
  notes: { resolve: value => resolveNotesPreferences(value as NotesPreferences | undefined), merge: 'authored' },
  markdown: { resolve: value => resolveMarkdownPreferences(value as MarkdownPreferences | undefined), merge: 'authored' },
  goals: { resolve: value => resolveGoalsPreferences(value as GoalsPreferences | undefined), merge: 'authored' },
  promotion: { resolve: value => value ?? { enabled: true }, merge: 'authored' },
  messageToolCompletion: { resolve: value => resolveComposerInputConfig(value as ComposerInputConfig | undefined), merge: 'resolved',
    // null is an authored disabled prefix, not a missing preference.
    field: (_key, value, fallback) => value === undefined ? fallback : value },
  goalsCommonActions: { resolve: value => resolveGoalsCommonActions(value as GoalsCommonActionsConfig | undefined), merge: 'resolved' },
  agentDerivedActions: { resolve: value => value ?? {}, merge: 'authored' },
  'agentDerivedActions.actions': { resolve: value => value ?? [], merge: 'resolved' },
  'agentDerivedActions.hidden': { resolve: value => value ?? [] },
  toolkit: { resolve: value => value ?? { performance: DEFAULT_PERFORMANCE_PREFERENCES, mobileConnection: DEFAULT_MOBILE_CONNECTION_PREFERENCES }, merge: 'resolved' },
  'toolkit.performance': { resolve: value => value ?? DEFAULT_PERFORMANCE_PREFERENCES, merge: 'resolved' },
  'toolkit.mobileConnection': { resolve: value => value ?? DEFAULT_MOBILE_CONNECTION_PREFERENCES, merge: 'resolved' },
  'toolkit.tools': { resolve: value => value ?? [], merge: 'resolved' },
  'appearance.channelHeaderVisibility': { resolve: value => value ?? {}, merge: 'authored', field: (_key, value) => value ?? true }
} satisfies Record<string, PreferenceDomain>))

// Derive defaults once, rather than resolving every unrelated domain for each edited field.
const preferenceDefaults = new Map([...preferenceDomains].map(([path, domain]) => [path, domain.resolve(undefined)]))

function effective(path: string, value: unknown): unknown {
  const domain = preferenceDomains.get(path)
  if (domain) return domain.resolve(value)
  const separator = path.lastIndexOf('.'), parent = path.slice(0, separator), key = path.slice(separator + 1)
  const parentDomain: PreferenceDomain | undefined = preferenceDomains.get(parent)
  if (parentDomain) {
    if (parentDomain.fields && Object.hasOwn(parentDomain.fields, key)) return parentDomain.fields[key]!(value)
    const defaults = preferenceDefaults.get(parent) as Record<string, unknown>
    const fallback = Object.hasOwn(defaults, key) ? defaults[key] : undefined
    return parentDomain.field ? parentDomain.field(key, value, fallback) : value ?? fallback
  }
  if (path === 'browser.automaticMemoryRelease') return value ?? true
  if (path === 'appearance.conversationDetailLevel') return value === undefined ? CONVERSATION_DETAIL_LEVEL_DEFAULT : value
  if (path === 'appearance.conversationShowSendReceipts') return value === undefined ? resolveConversationShowSendReceipts(undefined) : value
  if (path === 'appearance.conversationConfirmedSendReceipt') return value === undefined ? resolveConversationConfirmedSendReceipt(undefined) : value
  if (path === 'projectRailDensity') return value ?? PROJECT_RAIL_DENSITY_DEFAULT
  if (path === 'gitHistoryShowTime') return value ?? true
  if (path === 'messageToolInitialLayout') return value ?? MESSAGE_TOOL_INITIAL_LAYOUT_DEFAULT
  if (path === 'moteDirectoryView') return value ?? MOTE_DIRECTORY_VIEW_DEFAULT
  if (path === 'topicDirectoryInitialView') return value ?? TOPIC_DIRECTORY_INITIAL_VIEW_DEFAULT
  if (path === 'moteDirectoryAvatarSize') return value ?? MOTE_DIRECTORY_AVATAR_SIZE_DEFAULT
  if (path === 'copyPathsAsAbsolute' || path === 'browser.agentAutomation') return value ?? false
  if (path === 'appearance.customThemes') return value ?? {}
  if (path === 'appearance.themeId') return value ?? DEFAULT_THEME_ID
  if (path === 'appearance.appIcon') return value ?? DEFAULT_APP_ICON
  if (path === 'appearance.appAppearance') return value ?? APP_APPEARANCE_DEFAULT
  if (path === 'appearance.terminalFontSize') return value ?? TERMINAL_FONT_SIZE_DEFAULT
  if (path === 'notifications.mode') return value ?? DEFAULT_NOTIFICATION_MODE_ID
  if (path === 'notifications.sound') return value ?? DEFAULT_NOTIFICATION_SOUND
  return value
}

export class ConfigConflict extends Error {
  readonly code = 'CONFIG_CONFLICT'
  constructor(readonly field: string) {
    super(`“${field}” changed since you started editing. Your draft is kept. Review the current setting before saving again.`)
  }
}

/** Apply only authored differences; this is an internal edit, never a public path setter. */
export function applyConfigEdit(current: AppConfig, before: AppConfig, after: AppConfig): AppConfig {
  function merge(actual: unknown, expected: unknown, requested: unknown, path: string): unknown {
    if (configValuesEqual(effective(path, expected), effective(path, requested))) return actual
    if (configValuesEqual(effective(path, actual), effective(path, requested))) return actual
    const domain = preferenceDomains.get(path)
    if (domain?.merge) {
      // Compare defaults without persisting optional fields the user did not edit.
      actual = domain.merge === 'authored' ? actual ?? {} : effective(path, actual)
      expected = effective(path, expected); requested = effective(path, requested)
    }
    // A theme record is authored as one complete value; never synthesize variants or icon assets.
    if (path === 'appearance.customThemes') {
      const live = (actual ?? {}) as Record<string, unknown>, old = (expected ?? {}) as Record<string, unknown>, next = (requested ?? {}) as Record<string, unknown>
      const result = { ...live }
      for (const id of new Set([...Object.keys(old), ...Object.keys(next)])) {
        if (configValuesEqual(old[id], next[id]) || configValuesEqual(live[id], next[id])) continue
        if (!configValuesEqual(live[id], old[id])) throw new ConfigConflict(`${path}[${JSON.stringify(id)}]`)
        if (!Object.hasOwn(next, id)) delete result[id]
        else Object.defineProperty(result, id, { value: next[id], enumerable: true, configurable: true, writable: true })
      }
      return result
    }
    // An object identity is opaque (including dots in its directory); its authored choice is
    // one value. Merge unrelated identities, but never synthesize a face from concurrent parts.
    if (path === 'appearance.spaceObjectIcons' && actual && expected && requested &&
        typeof actual === 'object' && typeof expected === 'object' && typeof requested === 'object' &&
        !Array.isArray(actual) && !Array.isArray(expected) && !Array.isArray(requested)) {
      const live = actual as Record<string, unknown>, old = expected as Record<string, unknown>, next = requested as Record<string, unknown>
      const result = { ...live }
      for (const key of new Set([...Object.keys(old), ...Object.keys(next)])) {
        const previous = old[key], choice = next[key], currentChoice = live[key]
        if (configValuesEqual(previous, choice) || configValuesEqual(currentChoice, choice)) continue
        if (!configValuesEqual(current.appearance.spaceObjectIconRevisions?.[key], before.appearance.spaceObjectIconRevisions?.[key]))
          throw new ConfigConflict(`${path}[${JSON.stringify(key)}]`)
        if (!configValuesEqual(currentChoice, previous)) throw new ConfigConflict(`${path}[${JSON.stringify(key)}]`)
        if (!Object.hasOwn(next, key)) delete result[key]
        else Object.defineProperty(result, key, { value: choice, enumerable: true, configurable: true, writable: true })
      }
      return result
    }
    // Environment is one literal launch value, never a merge of independently authored keys.
    if (/^executors\.[^.]+\.env$/.test(path)) {
      if (!configValuesEqual(actual, expected)) throw new ConfigConflict(path)
      return requested
    }
    // Each exact container authors one display choice; unrelated containers merge independently.
    if (path === 'focus.zonePresentations') {
      type Choice = { key: string; presentation: string }
      const index = (value: unknown) => new Map(((value ?? []) as Choice[]).map(item => [item.key, item]))
      const old = index(expected), next = index(requested), live = index(actual), result = new Map(live)
      for (const key of new Set([...old.keys(), ...next.keys()])) {
        const value = merge(live.get(key), old.get(key), next.get(key), `${path}[${JSON.stringify(key)}]`)
        if (value === undefined) result.delete(key)
        else result.set(key, value as Choice)
      }
      return [...result.values()]
    }
    if (Array.isArray(expected) && Array.isArray(requested) && Array.isArray(actual) &&
        (path === 'workspaces' || path === 'hosts' || path === 'composerShortcuts' || path === 'toolkit.tools' || path === 'agentDerivedActions.actions')) {
      type RecordWithId = { id: string }
      const old = new Map((expected as RecordWithId[]).map((record) => [record.id, record]))
      const next = new Map((requested as RecordWithId[]).map((record) => [record.id, record]))
      const live = new Map((actual as RecordWithId[]).map((record) => [record.id, record]))
      const merged = new Map(live)
      for (const id of new Set([...old.keys(), ...next.keys()])) {
        const value = merge(live.get(id), old.get(id), next.get(id), `${path}.${id}`)
        if (value === undefined) merged.delete(id)
        else merged.set(id, value as RecordWithId)
      }
      return [...merged.values()]
    }
    if (actual && expected && requested && !Array.isArray(actual) && !Array.isArray(expected) && !Array.isArray(requested) &&
        typeof actual === 'object' && typeof expected === 'object' && typeof requested === 'object') {
      const live = actual as Record<string, unknown>, old = expected as Record<string, unknown>, next = requested as Record<string, unknown>
      const result = { ...live }
      for (const key of new Set([...Object.keys(old), ...Object.keys(next)])) {
        const own = (record: Record<string, unknown>) => Object.hasOwn(record, key) ? record[key] : undefined
        const value = merge(own(live), own(old), own(next), path ? `${path}.${key}` : key)
        if (value === undefined) delete result[key]
        else Object.defineProperty(result, key, { value, enumerable: true, configurable: true, writable: true })
      }
      // Visible official actions and no user list is the default; it is not written back as an empty record.
      if (path === 'agentDerivedActions' && Object.keys(result).length === 0 && !Object.hasOwn(next, 'actions') && !Object.hasOwn(next, 'hidden')) return undefined
      return result
    }
    if (!configValuesEqual(effective(path, actual), effective(path, expected))) throw new ConfigConflict(path)
    return requested
  }
  return merge(current, before, after, '') as AppConfig
}
