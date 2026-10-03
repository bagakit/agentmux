import { useId } from 'react'
import { NOTE_CONTENT_WIDTHS, NOTE_FONT_SIZE_MIN, NOTE_FONT_SIZE_MAX, resolveNotesPreferences, validNoteFontSize, type NotesPreferences } from '../../../../shared/notes-preferences'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { useSettingDraftRecord } from './use-setting-draft'
import '../../styles/settings-workflows.css'

export function NotesSettingsPane({ preferences, onSave, onOpenNotes }: {
  preferences: NotesPreferences | undefined
  onSave(value: Required<NotesPreferences>, expected: Required<NotesPreferences>): Promise<void>
  onOpenNotes(): void
}) {
  const saved = resolveNotesPreferences(preferences)
  const draft = useSettingDraftRecord({ fontSize: String(saved.fontSize), contentWidth: saved.contentWidth })
  const saveState = useSettingsSave(), widthGroup = useId(), fontId = useId()
  const fontSize = Number(draft.value.fontSize)
  const valid = /^\d+$/.test(draft.value.fontSize) && validNoteFontSize(fontSize)
  async function save(): Promise<void> {
    const submitted = draft.beginSave()
    submitted.finish(await saveState.run(async () => {
      if (!valid) throw new Error(`Choose a whole-number font size from ${NOTE_FONT_SIZE_MIN} to ${NOTE_FONT_SIZE_MAX} px.`)
      await onSave({ fontSize, contentWidth: submitted.value.contentWidth },
        { fontSize: Number(submitted.expected.fontSize), contentWidth: submitted.expected.contentWidth })
    }))
  }
  return <div className="settings-pane-stack">
    <section className="settings-group">
      <header><span>Reading</span><small>Saved: {saved.fontSize} px · {saved.contentWidth === 'wide' ? 'Wide' : 'Standard'}</small></header>
      <div className="settings-reading-size">
        <label htmlFor={fontId}><strong>Body text size</strong><small>Applies to Notes and embedded note text.</small></label>
        <div><input id={fontId} type="text" inputMode="numeric" aria-label="Notes body text size" value={draft.value.fontSize}
          onChange={event => draft.setField('fontSize', event.target.value)} aria-invalid={!valid} /><span>px</span></div>
      </div>
      <input className="settings-reading-slider" type="range" min={NOTE_FONT_SIZE_MIN} max={NOTE_FONT_SIZE_MAX} step={1}
        aria-label="Adjust Notes body text size" value={valid ? fontSize : saved.fontSize} onChange={event => draft.setField('fontSize', event.target.value)} />
      <fieldset className="settings-reading-width"><legend>Reading width</legend>
        {NOTE_CONTENT_WIDTHS.map(width => <label key={width} data-selected={draft.value.contentWidth === width}>
          <input type="radio" name={widthGroup} checked={draft.value.contentWidth === width} onChange={() => draft.setField('contentWidth', width)} />
          <span><strong>{width === 'standard' ? 'Standard' : 'Wide'}</strong><small>{width === 'standard' ? 'A focused reading column' : 'Use the available space'}</small></span>
        </label>)}
      </fieldset>
      <div className="settings-reading-preview" data-width={draft.value.contentWidth} aria-label="Notes reading preview">
        <div style={{ fontSize: valid ? fontSize : saved.fontSize }}><span>Reading preview</span><h3>A place to think clearly</h3>
          <p>Keep the ideas worth returning to. Your notes stay editable, connected to their sources, and easy to read at your own pace.</p>
        </div>
      </div>
    </section>
    <div className="settings-workflows__inline-action"><p className="settings-workflows__note">Organize notebooks, pages and sources in Notes.</p>
      <button type="button" className="small-button" onClick={onOpenNotes}>Open Notes</button>
    </div>
    <SettingsSaveBar save={saveState} dirty={draft.dirty} onSave={() => void save()} />
  </div>
}
