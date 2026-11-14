/** Personal presentation only. The original Host/Project key is also used by Focus filters. */
export const FOCUS_PROJECT_COLORS = ['default', 'blue', 'green', 'amber', 'rose', 'violet'] as const
export type FocusProjectColor = typeof FOCUS_PROJECT_COLORS[number]
export type FocusProjectPreference = { key: string; pinned: boolean; note: string; color: FocusProjectColor; collapsed: boolean | null }
export const EMPTY_FOCUS_PROJECTS: readonly FocusProjectPreference[] = []

export function parseFocusProjects(value: unknown): FocusProjectPreference[] {
  if (!Array.isArray(value)) throw Error('Focus projects must be a JSON array of personal project preferences.')
  const seen = new Set<string>()
  return value.map(item => {
    if (!item || typeof item !== 'object' || Object.keys(item).sort().join(',') !== 'collapsed,color,key,note,pinned'
      || typeof item.key !== 'string' || typeof item.note !== 'string' || typeof item.pinned !== 'boolean'
      || !FOCUS_PROJECT_COLORS.includes(item.color) || item.collapsed !== null && typeof item.collapsed !== 'boolean') {
      throw Error('Each Focus project needs key, pinned, note, color and collapsed (boolean or null).')
    }
    let identity: unknown
    try { identity = JSON.parse(item.key) } catch { /* Report this exact setting below. */ }
    if (!Array.isArray(identity) || identity.length !== 2 || !identity.every(part => typeof part === 'string' && part.length > 0)
      || JSON.stringify(identity) !== item.key || seen.has(item.key)) throw Error('Focus project keys must be unique original [Host, Project] identities.')
    seen.add(item.key)
    return { key: item.key, pinned: item.pinned, note: item.note, color: item.color, collapsed: item.collapsed }
  })
}

export function focusProjectPreference(key: string, preferences: readonly FocusProjectPreference[]): FocusProjectPreference {
  return preferences.find(item => item.key === key) ?? { key, pinned: false, note: '', color: 'default', collapsed: null }
}

/** An explicit destination in the saved pin order, retaining absent and unpinned preferences. */
export function moveFocusProject(preferences: readonly FocusProjectPreference[], key: string, before: string, after = false): FocusProjectPreference[] {
  const moving = preferences.find(item => item.key === key && item.pinned)
  if (!moving || key === before || !preferences.some(item => item.key === before && item.pinned)) return [...preferences]
  const next = preferences.filter(item => item.key !== key)
  next.splice(next.findIndex(item => item.key === before) + Number(after), 0, moving)
  return next
}

export const focusProjectTint = (color: FocusProjectColor) => ({ default: 'var(--text-3)', blue: 'var(--blue)', green: 'var(--green)', amber: 'var(--amber)', rose: 'var(--red)', violet: 'var(--purple)' })[color]
