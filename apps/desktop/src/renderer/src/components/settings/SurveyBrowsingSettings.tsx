import { Switch } from '@agentmux/client-ui/input'
import { resolveSurveyBrowsing, SURVEY_GROUP_GAP_MINUTES, type SurveyBrowsingPreferences } from '../../../../shared/survey-browsing'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { useSettingDraftRecord } from './use-setting-draft'
import { SelectionField } from '../SelectionField'

const groupingOptions = [
  { value: 'none', label: 'List order' },
  { value: 'site', label: 'By site' },
  { value: 'time', label: 'By opening interval' }
] satisfies { value: SurveyBrowsingPreferences['pageGrouping']; label: string }[]

export function SurveyBrowsingSettings({ preferences, onSave }: {
  preferences: Partial<SurveyBrowsingPreferences> | undefined
  onSave(value: SurveyBrowsingPreferences, expected: SurveyBrowsingPreferences): Promise<void>
}) {
  const draft = useSettingDraftRecord(resolveSurveyBrowsing(preferences)), save = useSettingsSave()
  async function commit() {
    const submitted = draft.beginSave()
    submitted.finish(await save.run(() => onSave(submitted.value, submitted.expected)))
  }

  return <section className="settings-group settings-survey-browsing" aria-label="Survey browsing">
    <header><span>Browsing</span></header>
    <label className="settings-survey-browsing__reuse" data-settings-field="reuse-open-pages">
      <span>Switch to an already open page
        <small>Matches the full link in the same browser environment.</small></span>
      <Switch aria-label="Switch to an already open page" checked={draft.value.reuseOpenPages}
        onChange={event => draft.setField('reuseOpenPages', event.target.checked)} />
    </label>
    <div className="settings-survey-browsing__field" data-settings-field="page-grouping">
      <span>Group saved webpages</span>
      <SelectionField label="Group saved webpages" value={draft.value.pageGrouping} options={groupingOptions} searchable={false}
        onValueChange={value => draft.setField('pageGrouping', value as SurveyBrowsingPreferences['pageGrouping'])} />
    </div>
    {draft.value.pageGrouping === 'time' ? <label className="settings-survey-browsing__gap" data-settings-field="page-group-gap">
      <span>Minimum gap between groups</span>
      <span className="settings-survey-browsing__range">
        <input aria-label="Minutes between webpage groups" type="range" min={SURVEY_GROUP_GAP_MINUTES.min} max={SURVEY_GROUP_GAP_MINUTES.max}
          value={draft.value.groupGapMinutes} onChange={event => draft.setField('groupGapMinutes', Number(event.target.value))} />
        <output>{draft.value.groupGapMinutes} min</output>
      </span>
    </label> : null}
    <SettingsSaveBar save={save} dirty={draft.dirty} resolution={draft} scopeLabel="Survey browsing" label="Save browsing settings" onSave={() => void commit()} />
  </section>
}
