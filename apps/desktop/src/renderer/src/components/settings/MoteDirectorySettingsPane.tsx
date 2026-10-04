import type { CSSProperties } from 'react'
import { ArrowUpRight, List, Users } from 'lucide-react'
import { MOTE_DIRECTORY_VIEW_DEFAULT, MOTE_DIRECTORY_VIEW_IDS, MOTE_DIRECTORY_AVATAR_SIZE_DEFAULT, MOTE_DIRECTORY_AVATAR_SIZE_MIN, MOTE_DIRECTORY_AVATAR_SIZE_MAX, type MoteDirectoryView } from '../../../../shared/contracts'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { useSettingDraftRecord } from './use-setting-draft'
import '../../styles/mote-directory.css'

export const moteDirectoryViewLabel = (value: MoteDirectoryView | undefined): string =>
  (value ?? MOTE_DIRECTORY_VIEW_DEFAULT) === 'collaborators' ? 'Collaborators' : 'List'

export type MoteDirectoryDisplay = { view: MoteDirectoryView; avatarSize: number }

export function MoteDirectorySettingsPane({ view, avatarSize, onSave, onOpen }: {
  view: MoteDirectoryView | undefined
  avatarSize: number | undefined
  onSave(value: MoteDirectoryDisplay, expected: MoteDirectoryDisplay): Promise<void>
  onOpen(): void
}) {
  const draft = useSettingDraftRecord({ view: view ?? MOTE_DIRECTORY_VIEW_DEFAULT, avatarSize: avatarSize ?? MOTE_DIRECTORY_AVATAR_SIZE_DEFAULT }), save = useSettingsSave()
  async function commit(): Promise<void> {
    const submitted = draft.beginSave()
    submitted.finish(await save.run(() => onSave(submitted.value, submitted.expected)))
  }
  return <div className="settings-pane-stack">
    <section className="settings-group">
      <header><span>Mote directory</span><small>{moteDirectoryViewLabel(view)}</small></header>
      <fieldset className="mote-directory-settings" style={{ '--mote-directory-avatar-size': `${draft.value.avatarSize}px` } as CSSProperties}><legend className="sr-only">Mote directory view</legend>
        {MOTE_DIRECTORY_VIEW_IDS.map(value => <label key={value} data-selected={draft.value.view === value}>
          <span className="mote-directory-settings__preview" data-view={value} aria-hidden="true">
            {[0, 1, 2].map(index => <span key={index}><i /><b /></span>)}
          </span>
          <span className="mote-directory-settings__choice"><input type="radio" name="mote-directory-view" value={value} checked={draft.value.view === value} onChange={() => draft.setField('view', value)} />
            {value === 'collaborators' ? <Users size={14} /> : <List size={14} />}{moteDirectoryViewLabel(value)}</span>
        </label>)}
      </fieldset>
      <label className="mote-directory-size"><span>Avatar size</span><input type="range" min={MOTE_DIRECTORY_AVATAR_SIZE_MIN} max={MOTE_DIRECTORY_AVATAR_SIZE_MAX} step={1} value={draft.value.avatarSize}
        onChange={event => draft.setField('avatarSize', Number(event.target.value))} /><output>{draft.value.avatarSize}px</output></label>
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
