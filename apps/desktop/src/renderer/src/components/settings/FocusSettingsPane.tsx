import { useRef, useState } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { FOCUS_RECENT_ACTIVITY_HOURS, FOCUS_REPLY_LINES, FOCUS_RECENT_INPUTS, resolveFocusPreferences, type FocusPreferences } from '../../../../shared/focus-preferences'
import { useAppStore } from '../../store'
import { FocusTimelineRulerSettings } from '../FocusTimelineRulerSettings'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { useSettingDraftRecord } from './use-setting-draft'
import { FocusSettingsPreview, type FocusPreviewScene } from './FocusSettingsPreview'
import { useSettingsPreviewReturn } from './use-settings-preview-return'
import { configValuesEqual } from '../../../../shared/config-edit'
import { DEFAULT_FOCUS_MAP_PREFERENCES, focusMapPreferencesIssue } from '../../../../shared/focus-map-preferences'
import { FocusMapSettings } from './FocusMapSettings'
import '../../styles/settings-focus.css'
import '../../styles/settings-workview-layout.css'

const PreviewIcon = semanticIconComponent('action.preview')
export type FocusSettingsValues = Required<FocusPreferences>
function Choices<T extends string | number>({ id, legend, value, options, onChange }: {
  id: string; legend: string; value: T; options: readonly { value: T; label: string; hint?: string }[]; onChange(value: T): void
}) {
  return <fieldset className="focus-settings-window" data-settings-field={id} data-settings-preview-label={legend}><legend>{legend}</legend>{options.map(option => <label key={option.value} data-selected={value === option.value}>
    <input type="radio" name={`focus-${id}`} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} />
    <span><strong>{option.label}</strong>{option.hint ? <small>{option.hint}</small> : null}</span>
  </label>)}</fieldset>
}

export function FocusSettingsPane({ preferences, active = true, onSave }: {
  preferences?: FocusPreferences | undefined; active?: boolean
  onSave(value: FocusSettingsValues, expected: FocusSettingsValues): Promise<void>
}) {
  const draft = useSettingDraftRecord(resolveFocusPreferences(preferences), configValuesEqual), saveState = useSettingsSave()
  const mapIssue = focusMapPreferencesIssue(draft.value.map), validMap = useRef(draft.value.map)
  if (!mapIssue) validMap.current = draft.value.map
  const [scene, setScene] = useState<FocusPreviewScene>('board')
  const preview = useSettingsPreviewReturn('Project scanning')
  const ruler = useAppStore(state => state.focusTimelineRuler), saveRuler = useAppStore(state => state.setFocusTimelineRuler)
  function change<K extends keyof FocusSettingsValues>(key: K, value: FocusSettingsValues[K], nextScene: FocusPreviewScene) {
    draft.setField(key, value); setScene(nextScene)
  }
  async function save() { const submitted = draft.beginSave(); submitted.finish(await saveState.run(() => onSave(submitted.value, submitted.expected))) }
  function reset() {
    const defaults = resolveFocusPreferences(undefined)
    for (const key of Object.keys(defaults) as (keyof FocusSettingsValues)[]) draft.setField(key, defaults[key])
  }
  function previewButton(group: string, title: string, nextScene: FocusPreviewScene) {
    return <button type="button" className="small-button settings-preview-open" data-settings-preview-open={group} data-settings-preview-title={title} onClick={event => { setScene(nextScene); preview.open(event.currentTarget) }}><PreviewIcon size={14} />View preview</button>
  }
  return <div ref={preview.rootRef} className="settings-pane-stack focus-settings" data-active={active} onFocusCapture={preview.remember} onInputCapture={preview.remember} onChangeCapture={preview.remember} onClickCapture={preview.remember}>
    <div className="focus-settings__intro"><p>Preview your choices before saving.</p><button type="button" className="small-button" onClick={reset}>Restore defaults</button></div>
    <div className="focus-settings__workspace">
      <div className="focus-settings__controls">
        <section className="settings-group" data-settings-preview-group="project-scanning"><header><span>Project scanning</span></header>
          <Choices id="recent-activity" legend="Recent activity window" value={draft.value.recentActivityHours} options={FOCUS_RECENT_ACTIVITY_HOURS.map(value => ({ value, label: value === 168 ? '1 week' : `${value}h` }))} onChange={value => change('recentActivityHours', value, 'board')} />
          <p className="focus-settings-description">Recent work moves forward. Attention and Working stay first; older projects remain available.</p>
          <Choices id="reply-lines" legend="Reply excerpt" value={draft.value.replyLines} options={FOCUS_REPLY_LINES.map(value => ({ value, label: `${value} ${value === 1 ? 'line' : 'lines'}`, hint: value === 1 ? 'Scan faster' : value === 2 ? 'Balanced' : 'More context' }))} onChange={value => change('replyLines', value, 'board')} />
          {previewButton('project-scanning', 'Project scanning', 'board')}
        </section>
        <section className="settings-group" data-settings-preview-group="agent-reading"><header><span>Agent reading</span></header>
          <Choices id="preview-trigger" legend="Automatic preview" value={draft.value.previewTrigger} options={[{ value: 'quick', label: 'Quick', hint: 'A short pause' }, { value: 'deliberate', label: 'Deliberate', hint: 'A longer pause' }, { value: 'keyboard', label: 'Keyboard only', hint: 'Use the reading key' }]} onChange={value => change('previewTrigger', value, 'reading')} />
          <p className="focus-settings-description">Shared by Focus and other Agent cards. Clicking still opens the Agent.</p>
          <Choices id="recent-inputs" legend="Recent inputs in a new preview" value={draft.value.recentInputs} options={FOCUS_RECENT_INPUTS.map(value => ({ value, label: `${value} inputs` }))} onChange={value => change('recentInputs', value, 'reading')} />
          <p className="focus-settings-description">Uses the existing reading window. Open bookmarks keep the text you are reading.</p>
          {previewButton('agent-reading', 'Agent reading', 'reading')}
        </section>
        <section className="settings-group" data-settings-preview-group="opening-resources"><header><span>Opening resources</span></header>
          <Choices id="link-destination" legend="Open links in Focus" value={draft.value.linkDestination} options={[{ value: 'region', label: 'Beside the Agent', hint: 'Keep both in view' }, { value: 'tab', label: 'New Tab in Space', hint: 'Give the resource room' }]} onChange={value => change('linkDestination', value, 'links')} />
          <p className="focus-settings-description">Alt-click chooses a position for that link.</p>
          {previewButton('opening-resources', 'Opening resources', 'links')}
        </section>
        <section className="settings-group" data-settings-field="map" data-settings-preview-group="map" onFocusCapture={() => setScene('map')}><header><span>Map</span><button type="button" className="small-button" onClick={() => change('map', DEFAULT_FOCUS_MAP_PREFERENCES, 'map')}>Restore Map defaults</button></header>
          <FocusMapSettings value={draft.value.map} onChange={value => change('map', value, 'map')} />
          {mapIssue ? <p className="settings-inline-error" role="alert">{mapIssue} Your draft is kept.</p> : null}
          <Choices id="map-motion" legend="Map motion" value={draft.value.mapMotion} options={[{ value: 'system', label: 'Follow system', hint: 'Respect reduced motion' }, { value: 'on', label: 'On', hint: 'Animate recent activity' }, { value: 'off', label: 'Off', hint: 'Keep activity still' }]} onChange={value => draft.setField('mapMotion', value)} />
          <p className="focus-settings-description">Only changes movement on the map. New messages and activity remain visible.</p>
          {previewButton('map', 'Map', 'map')}
        </section>
        <div className="focus-settings__timeline" data-settings-field="timeline"><span><strong>Timeline</strong><small>Use the same ruler and time zone settings as Focus.</small></span><FocusTimelineRulerSettings active={active} preferences={ruler} onChange={saveRuler} dateChoice={null} onSelectDate={() => {}} onCancelDate={() => {}} /></div>
      </div>
      <FocusSettingsPreview values={{ ...draft.value, map: validMap.current }} mapPreviewLastValid={Boolean(mapIssue)} active={active} scene={scene} onScene={setScene} previewRef={preview.previewRef} returnAction={preview.returnAction} />
    </div>
    <SettingsSaveBar save={saveState} dirty={draft.dirty} disabled={Boolean(mapIssue)} onSave={() => void save()} />
  </div>
}
