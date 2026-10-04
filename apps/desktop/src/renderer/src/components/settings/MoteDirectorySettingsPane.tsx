import { ArrowUpRight, List, Users } from 'lucide-react'
import { MOTE_DIRECTORY_VIEW_DEFAULT, MOTE_DIRECTORY_VIEW_IDS, type MoteDirectoryView } from '../../../../shared/contracts'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { useSettingDraft } from './use-setting-draft'
import '../../styles/mote-directory.css'

export const moteDirectoryViewLabel = (value: MoteDirectoryView | undefined): string =>
  (value ?? MOTE_DIRECTORY_VIEW_DEFAULT) === 'collaborators' ? 'Collaborators' : 'List'

export function MoteDirectorySettingsPane({ view, onSave, onOpen }: {
  view: MoteDirectoryView | undefined
  onSave(value: MoteDirectoryView, expected: MoteDirectoryView): Promise<void>
  onOpen(): void
}) {
  const draft = useSettingDraft(view ?? MOTE_DIRECTORY_VIEW_DEFAULT), save = useSettingsSave()
  async function commit(): Promise<void> {
    const submitted = draft.beginSave()
    submitted.finish(await save.run(() => onSave(submitted.value, submitted.expected)))
  }
  return <div className="settings-pane-stack">
    <section className="settings-group">
      <header><span>Mote directory</span><small>{moteDirectoryViewLabel(view)}</small></header>
      <fieldset className="mote-directory-settings"><legend className="sr-only">Mote directory view</legend>
        {MOTE_DIRECTORY_VIEW_IDS.map(value => <label key={value} data-selected={draft.value === value}>
          <span className="mote-directory-settings__preview" data-view={value} aria-hidden="true">
            {[0, 1, 2].map(index => <span key={index}><i /><b /></span>)}
          </span>
          <span className="mote-directory-settings__choice"><input type="radio" name="mote-directory-view" value={value} checked={draft.value === value} onChange={() => draft.setValue(value)} />
            {value === 'collaborators' ? <Users size={14} /> : <List size={14} />}{moteDirectoryViewLabel(value)}</span>
        </label>)}
      </fieldset>
      <SettingsSaveBar save={save} dirty={draft.dirty} onSave={() => void commit()} />
    </section>
    <section className="settings-group">
      <header><span>Your collaborators</span></header>
      <div className="settings-workflows__inline-action">
        <p className="settings-workflows__note">Profiles, avatars and behavior belong to each Mote.</p>
        <button type="button" className="small-button" onClick={onOpen}>Open Mote Club<ArrowUpRight size={14} aria-hidden="true" /></button>
      </div>
    </section>
  </div>
}
