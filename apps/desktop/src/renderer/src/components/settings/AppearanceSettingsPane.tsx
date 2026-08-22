import { Palette, SquareTerminal } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AppearanceConfig, AppAppearanceId, TerminalThemeId, AgentExecutorConfig, AgentAvatarAppearance, AgentAvatarBadge } from '../../../../shared/contracts'
import {
  AGENT_AVATAR_BADGE_IDS,
  AGENT_AVATAR_BADGE_LABELS,
  TERMINAL_FONT_SIZE_DEFAULT,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN
} from '../../../../shared/contracts'
import { AgentAvatar } from '../AgentAvatar'
import { presentError } from '../../lib/error-presentation'
import { TERMINAL_THEME_CATALOG } from '../../lib/terminal-theme'

export function AppearanceSettingsPane({ appearance, executors, onSave }: {
  appearance: AppearanceConfig
  executors: Record<string, AgentExecutorConfig>
  onSave: (appearance: AppearanceConfig) => Promise<void>
}) {
  const [appAppearance, setAppAppearance] = useState<AppAppearanceId>(appearance.appAppearance ?? 'dark')
  const [terminalTheme, setTerminalTheme] = useState<TerminalThemeId>(appearance.terminalTheme)
  const savedFontSize = appearance.terminalFontSize ?? TERMINAL_FONT_SIZE_DEFAULT
  const [fontSize, setFontSize] = useState<number>(savedFontSize)
  const [avatars, setAvatars] = useState(appearance.agentAvatars ?? {})
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => setAvatars(appearance.agentAvatars ?? {}), [appearance.agentAvatars])
  useEffect(() => setAppAppearance(appearance.appAppearance ?? 'dark'), [appearance.appAppearance])
  useEffect(() => setTerminalTheme(appearance.terminalTheme), [appearance.terminalTheme])
  useEffect(() => setFontSize(savedFontSize), [savedFontSize])

  const dirty = appAppearance !== (appearance.appAppearance ?? 'dark') || terminalTheme !== appearance.terminalTheme || fontSize !== savedFontSize || JSON.stringify(avatars) !== JSON.stringify(appearance.agentAvatars ?? {})

  async function save(): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      await onSave({ ...appearance, appAppearance, terminalTheme, terminalFontSize: fontSize, agentAvatars: avatars })
    } catch (cause) {
      setError(presentError(cause))
    } finally {
      setSaving(false)
    }
  }

  function updateAvatar(id: string, patch: AgentAvatarAppearance): void {
    setAvatars((current) => ({ ...current, [id]: { ...current[id], ...patch } }))
  }

  function setAvatarBadge(id: string, badge: AgentAvatarBadge | undefined): void {
    setAvatars((current) => {
      const next = { ...current }
      const avatar = { ...next[id] }
      if (badge) avatar.badge = badge
      else delete avatar.badge
      if (Object.keys(avatar).length > 0) next[id] = avatar
      else delete next[id]
      return next
    })
  }

  return (
    <div className="settings-pane-stack">
      <p className="settings-lead">AgentMux chrome stays quiet and consistent; the Terminal owns its palette. PTY and CtxMux transport bytes and never rewrite color.</p>
      <section className="settings-group">
        <header><span>Application appearance</span><small>Chrome</small></header>
        <div className="terminal-theme-grid" role="radiogroup" aria-label="Application appearance">
          {(['dark', 'light', 'system'] as const).map((mode) => (
            <button type="button" key={mode} className={`terminal-theme-choice ${appAppearance === mode ? 'terminal-theme-choice--selected' : ''}`} role="radio" aria-checked={appAppearance === mode} onClick={() => setAppAppearance(mode)}>
              <span className="terminal-theme-choice__copy"><strong>{mode === 'system' ? 'Follow system' : mode === 'dark' ? 'Dark' : 'Light'}</strong><small>{mode === 'system' ? 'Match your operating system' : `Use ${mode} surfaces`}</small></span>
            </button>
          ))}
        </div>
      </section>
      <section className="settings-group">
        <header><span>Terminal palette</span><small>{TERMINAL_THEME_CATALOG.length}</small></header>
        <div className="terminal-theme-grid" role="radiogroup" aria-label="Terminal palette">
          {TERMINAL_THEME_CATALOG.map((definition) => {
            const selected = terminalTheme === definition.id
            const theme = definition.theme
            return (
              <button
                type="button"
                key={definition.id}
                className={`terminal-theme-choice ${selected ? 'terminal-theme-choice--selected' : ''}`}
                role="radio"
                aria-checked={selected}
                onClick={() => setTerminalTheme(definition.id)}
              >
                <span className="terminal-theme-preview" style={{ background: theme.background, color: theme.foreground }}>
                  <span className="terminal-theme-preview__chrome">
                    <i style={{ background: theme.red }} />
                    <i style={{ background: theme.yellow }} />
                    <i style={{ background: theme.green }} />
                  </span>
                  <span className="terminal-theme-preview__line"><b style={{ color: theme.green }}>›</b> Working in project</span>
                  <span className="terminal-theme-preview__composer" style={{ background: theme.black }}><b style={{ color: theme.blue }}>›</b> Ask or steer the agent…</span>
                </span>
                <span className="terminal-theme-choice__copy">
                  <strong>{definition.label}</strong>
                  <small>{definition.description}</small>
                </span>
                {selected ? <Palette size={14} /> : <SquareTerminal size={14} />}
              </button>
            )
          })}
        </div>
      </section>
      <section className="settings-group">
        <header><span>Terminal font size</span><small>{fontSize}px</small></header>
        <div className="terminal-font-size-control">
          {/* Range + number share one state. The range gives a quick drag; the number a precise value.
              Both are bounded by the SSOT min/max so the widget cannot express an out-of-range size in
              the first place — the authoritative clamp still lives in the persistence schema, this is
              only the affordance. `Math.round` keeps the number input from proposing a fractional cell
              metric before it is even saved. */}
          <input
            type="range"
            aria-label="Terminal font size"
            min={TERMINAL_FONT_SIZE_MIN}
            max={TERMINAL_FONT_SIZE_MAX}
            step={1}
            value={fontSize}
            onChange={(event) => setFontSize(Number(event.target.value))}
          />
          <input
            type="number"
            aria-label="Terminal font size in pixels"
            min={TERMINAL_FONT_SIZE_MIN}
            max={TERMINAL_FONT_SIZE_MAX}
            step={1}
            value={fontSize}
            onChange={(event) => {
              const next = Number(event.target.value)
              if (Number.isFinite(next)) {
                setFontSize(Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, Math.round(next))))
              }
            }}
          />
          <span className="terminal-font-size-control__unit">px</span>
        </div>
        <p className="settings-hint">Applies to every open terminal, from {TERMINAL_FONT_SIZE_MIN} to {TERMINAL_FONT_SIZE_MAX} pixels.</p>
      </section>
      <section className="settings-group">
        <header><span>Agent avatars</span><small>Per executor</small></header>
        <p className="settings-hint">Keep the Provider mark; add a tint and a fixed icon to distinguish your executors.</p>
        <div className="agent-avatar-settings">
          {Object.entries(executors).map(([id, executor]) => <div className="agent-avatar-settings__row" key={id}>
            <AgentAvatar label={executor.label} providerId={executor.providerId} state="running" appearance={avatars[id]} />
            <span className="agent-avatar-settings__name"><strong>{executor.label}</strong><small>{id}</small></span>
            <label>Tint{avatars[id]?.tint ? null : ' · off'}<input type="color" aria-label={`${executor.label} avatar tint`} value={avatars[id]?.tint ?? '#8ab4f8'}
              onChange={(event) => updateAvatar(id, { tint: event.target.value })} /></label>
            <label>Icon<select aria-label={`${executor.label} avatar icon`} value={avatars[id]?.badge ?? ''}
              onChange={(event) => setAvatarBadge(id, (event.target.value || undefined) as AgentAvatarBadge | undefined)}>
              <option value="">None</option>
              {AGENT_AVATAR_BADGE_IDS.map((badge) => <option key={badge} value={badge}>{AGENT_AVATAR_BADGE_LABELS[badge]}</option>)}
            </select></label>
            <button type="button" className="small-button" aria-label={`Reset ${executor.label} avatar`} disabled={!avatars[id]} onClick={() => setAvatars((current) => {
              const next = { ...current }; delete next[id]; return next
            })}>Reset</button>
          </div>)}
        </div>
      </section>
      {error ? <p className="settings-inline-error" role="alert">{error}</p> : null}
      <div className="settings-pane-actions">
        <span>The preview keeps the TUI input surface distinct from its work area.</span>
        <button className="primary-button" disabled={saving || !dirty} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save appearance'}
        </button>
      </div>
    </div>
  )
}
