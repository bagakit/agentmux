import { useId } from 'react'
import {
  BROWSER_AGENT_CONTROL_LIMITS, BROWSER_AGENT_GLOW_BLENDS, BROWSER_AGENT_GLOW_ANIMATIONS,
  DEFAULT_BROWSER_AGENT_CONTROL, resolveBrowserAgentControl, type BrowserAgentControlPreferences
} from '../../../../shared/browser-agent-control'
import { BrowserAgentControlPreview } from './BrowserAgentControlPreview'
import { useSettingDraftRecord } from './use-setting-draft'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import '../../styles/browser-agent-control-settings.css'

type NumericPreference = keyof typeof BROWSER_AGENT_CONTROL_LIMITS
export function BrowserAgentControlSettingsPane({ preferences, active, onSave }: {
  preferences: Partial<BrowserAgentControlPreferences> | undefined
  active: boolean
  onSave(value: BrowserAgentControlPreferences, expected: BrowserAgentControlPreferences): Promise<void>
}) {
  const saved = resolveBrowserAgentControl(preferences), draft = useSettingDraftRecord(saved), saveState = useSettingsSave(), id = useId()
  const value = draft.value
  const defaultsSelected = (Object.keys(DEFAULT_BROWSER_AGENT_CONTROL) as (keyof BrowserAgentControlPreferences)[]).every(key => value[key] === DEFAULT_BROWSER_AGENT_CONTROL[key])
  async function save() {
    const submitted = draft.beginSave()
    submitted.finish(await saveState.run(() => onSave(submitted.value, submitted.expected)))
  }
  function toggle(key: 'showCursor' | 'showCursorLabel' | 'showDiscussion' | 'pointerTween' | 'clickRipple' | 'glowEnabled', title: string, note?: string) {
    return <label className="browser-agent-control__toggle" data-settings-field={key}>
      <span><strong>{title}</strong>{note ? <small>{note}</small> : null}</span>
      <input type="checkbox" checked={value[key]} onChange={event => draft.setField(key, event.target.checked)} />
    </label>
  }
  function slider(key: NumericPreference, title: string, unit: string) {
    const { min, max, step } = BROWSER_AGENT_CONTROL_LIMITS[key]
    return <label className="browser-agent-control__range" data-settings-field={key} htmlFor={`${id}-${key}`}>
      <span>{title}<output htmlFor={`${id}-${key}`}>{key === 'glowOpacity' ? Math.round(value[key] * 100) : value[key]}{unit}</output></span>
      <input id={`${id}-${key}`} type="range" min={min} max={max} step={step} value={value[key]} onChange={event => draft.setField(key, Number(event.target.value))} />
    </label>
  }
  return <div className="settings-pane-stack browser-agent-control-settings">
    <p className="settings-group-note">Make agent activity easy to follow. These preferences change its appearance; takeover and messaging remain available.</p>
    <div className="browser-agent-control__layout">
      <div className="browser-agent-control__editor">
        <section className="settings-group">
          <header><span>Cursor & discussion</span></header>
          {toggle('showCursor', 'Show agent cursor')}
          {toggle('showCursorLabel', 'Show avatar & title')}
          {toggle('showDiscussion', 'Show discussion box', 'Open alongside agent activity. You can always open it yourself.')}
          {toggle('pointerTween', 'Animate cursor movement')}
          {toggle('clickRipple', 'Show click ripple')}
        </section>
        <section className="settings-group">
          <header><span>Inner glow</span></header>
          {toggle('glowEnabled', 'Highlight page edges')}
          <div className="browser-agent-control__pair">
            <label className="browser-agent-control__color" data-settings-field="glowColor"><span>Color</span><span><input aria-label="Glow color" type="color" value={value.glowColor} onChange={event => draft.setField('glowColor', event.target.value)} /><code>{value.glowColor.toUpperCase()}</code></span></label>
            <label data-settings-field="glowBlend"><span>Blend</span><select aria-label="Glow blend" value={value.glowBlend} onChange={event => draft.setField('glowBlend', event.target.value as BrowserAgentControlPreferences['glowBlend'])}>{BROWSER_AGENT_GLOW_BLENDS.map(blend => <option key={blend} value={blend}>{blend[0]!.toUpperCase() + blend.slice(1)}</option>)}</select></label>
          </div>
          {slider('glowWidth', 'Width', ' px')}
          {slider('glowOpacity', 'Intensity', '%')}
          <label className="browser-agent-control__select" data-settings-field="glowAnimation"><span>Animation</span><select aria-label="Glow animation" value={value.glowAnimation} onChange={event => draft.setField('glowAnimation', event.target.value as BrowserAgentControlPreferences['glowAnimation'])}>{BROWSER_AGENT_GLOW_ANIMATIONS.map(animation => <option key={animation} value={animation}>{animation === 'none' ? 'Static' : animation[0]!.toUpperCase() + animation.slice(1)}</option>)}</select></label>
        </section>
        <details className="browser-agent-control__advanced">
          <summary>Fine tuning</summary>
          <div>{slider('pointerDurationMs', 'Cursor travel', ' ms')}{slider('clickDurationMs', 'Ripple duration', ' ms')}{slider('clickRadius', 'Ripple radius', ' px')}{slider('glowSoftness', 'Glow softness', ' px')}{slider('glowDurationMs', 'Glow cycle', ' ms')}</div>
        </details>
        <button type="button" className="small-button browser-agent-control__reset" disabled={defaultsSelected} onClick={() => { for (const key of Object.keys(DEFAULT_BROWSER_AGENT_CONTROL) as (keyof BrowserAgentControlPreferences)[]) draft.setField(key, DEFAULT_BROWSER_AGENT_CONTROL[key]) }}>Reset draft to defaults</button>
      </div>
      <BrowserAgentControlPreview preferences={value} active={active} dirty={draft.dirty} />
    </div>
    <SettingsSaveBar save={saveState} dirty={draft.dirty} label="Save agent appearance" onSave={() => void save()} />
  </div>
}
