import type { CSSProperties } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { MOTE_DIRECTORY_VIEW_DEFAULT, MOTE_DIRECTORY_VIEW_IDS, MOTE_DIRECTORY_AVATAR_SIZE_DEFAULT, MOTE_DIRECTORY_AVATAR_SIZE_MIN, MOTE_DIRECTORY_AVATAR_SIZE_MAX, type MoteDirectoryView } from '../../../../shared/contracts'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { useSettingDraftRecord } from './use-setting-draft'
import { MoteOriginStory } from './MoteOriginStory'
import '../../styles/mote-directory.css'
import '../../styles/settings-mote.css'

const ThemeObjectTeamIcon = semanticIconComponent('object.team')
const ThemeObjectListIcon = semanticIconComponent('object.list')
const ThemeObjectUserIcon = semanticIconComponent('object.user')
const ThemeActionOpenExternalIcon = semanticIconComponent('action.open-external')


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
  return <div className="settings-pane-stack settings-mote">
    <MoteOriginStory />
    <section className="settings-group">
      <header><span>Directory view</span><small>Saved: {moteDirectoryViewLabel(view)}</small></header>
      <fieldset className="mote-directory-settings" style={{ '--mote-directory-avatar-size': `${draft.value.avatarSize}px` } as CSSProperties}><legend className="sr-only">Mote directory view</legend>
        {MOTE_DIRECTORY_VIEW_IDS.map(value => <label key={value} data-selected={draft.value.view === value}>
          <span className="mote-directory-settings__preview" data-view={value} aria-hidden="true">
            {[0, 1, 2].map(index => <span key={index}><i /><b /></span>)}
          </span>
          <span className="mote-directory-settings__choice"><input type="radio" name="mote-directory-view" value={value} checked={draft.value.view === value} onChange={() => draft.setField('view', value)} />
            {value === 'collaborators' ? <ThemeObjectTeamIcon size={14} /> : <ThemeObjectListIcon size={14} />}{moteDirectoryViewLabel(value)}</span>
        </label>)}
      </fieldset>
      <p className="settings-workflows__note">View examples. Choose how collaborators appear in Mote Club.</p>
    </section>
    <section className="settings-group">
      <header><span>Avatar size</span><small>Saved: {avatarSize ?? MOTE_DIRECTORY_AVATAR_SIZE_DEFAULT} px</small></header>
      <div className="settings-mote__sizing">
      <div className="settings-mote__avatar-preview" aria-label="Avatar size preview"><span style={{ width: draft.value.avatarSize, height: draft.value.avatarSize }}><ThemeObjectUserIcon size={draft.value.avatarSize * .7} strokeWidth={1.5} /></span><small>{draft.value.avatarSize} px</small></div>
      <div className="settings-mote__size-controls">
      <fieldset className="mote-directory-sizes"><legend className="sr-only">Avatar size presets</legend>
        {[24, 32, 40, 48].map(size => <button type="button" key={size} aria-label={`${size}px avatar`} aria-pressed={draft.value.avatarSize === size}
          onClick={() => draft.setField('avatarSize', size)}>{size}<small>px</small></button>)}
      </fieldset>
      <label className="mote-directory-size"><span>Size</span><input aria-label="Avatar size" type="range" min={MOTE_DIRECTORY_AVATAR_SIZE_MIN} max={MOTE_DIRECTORY_AVATAR_SIZE_MAX} step={1} value={draft.value.avatarSize}
        onChange={event => draft.setField('avatarSize', Number(event.target.value))} /><output>{draft.value.avatarSize}px</output></label>
      </div></div>
    </section>
    <section className="settings-group">
      <header><span>Your collaborators</span></header>
      <div className="settings-workflows__inline-action">
        <p className="settings-workflows__note">Profiles, avatars and behavior belong to each Mote.</p>
        <button type="button" className="small-button" onClick={onOpen}>Open Mote Club<ThemeActionOpenExternalIcon size={14} aria-hidden="true" /></button>
      </div>
    </section>
    <SettingsSaveBar save={save} dirty={draft.dirty} onSave={() => void commit()} />
  </div>
}
