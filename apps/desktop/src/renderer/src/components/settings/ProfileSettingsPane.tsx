import { TextInput } from '@agentmux/client-ui/input'
import { ComposerTextarea } from '../ComposerTextarea'
import { Camera, UserRound, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { resolveUserProfile, USER_PROFILE_NAME_LIMIT, USER_PROFILE_ABOUT_LIMIT, validProfileAvatar, type UserProfile } from '../../../../shared/user-profile'
import { MoteAvatarCrop } from '../MoteAvatarCrop'
import { SettingsSaveBar, useSettingsSave } from './SettingsSaveBar'
import { useSettingDraftRecord } from './use-setting-draft'
import './profile-settings.css'

export function ProfileSettingsPane({ profile, onSave }: {
  profile: UserProfile | undefined
  onSave: (value: UserProfile, expected: UserProfile) => Promise<void>
}) {
  const draft = useSettingDraftRecord(resolveUserProfile(profile))
  const value = draft.value, saveState = useSettingsSave()
  const upload = useRef<HTMLInputElement>(null), canvas = useRef<HTMLCanvasElement>(null)
  const photoButton = useRef<HTMLButtonElement>(null)
  const imageRequest = useRef(0)
  useEffect(() => () => { imageRequest.current++ }, [])
  const [source, setSource] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [imageError, setImageError] = useState('')

  async function chooseImage(file: File | undefined): Promise<void> {
    const request = ++imageRequest.current
    setImageError('')
    if (!file) return
    if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 8 * 1024 * 1024) {
      setImageError('Choose a static PNG or JPEG image smaller than 8 MiB.')
      return
    }
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(new Error('The image could not be read. Choose it again.'))
        reader.readAsDataURL(file)
      })
      if (request === imageRequest.current) { setReady(false); setSource(data) }
    } catch (cause) { if (request === imageRequest.current) setImageError(cause instanceof Error ? cause.message : String(cause)) }
  }

  function useCrop(): void {
    if (!ready || !canvas.current) return
    // The existing bounded crop owns positioning. JPEG keeps the configuration and CLI value small.
    const avatar = canvas.current.toDataURL('image/jpeg', 0.85)
    if (!validProfileAvatar(avatar)) { setImageError('This crop could not be saved. Choose another image.'); return }
    draft.setField('avatar', avatar)
    setSource(null)
    photoButton.current?.focus()
  }

  async function save(): Promise<void> {
    const submitted = draft.beginSave()
    submitted.finish(await saveState.run(() => onSave(submitted.value, submitted.expected)))
  }

  return <div className="settings-pane-stack settings-profile" aria-label="My Profile">
    <section className="settings-profile__identity">
      <div className="settings-profile__portrait" role="img" aria-label={value.displayName || 'Your avatar'}>
        {value.avatar ? <img src={value.avatar} alt="" /> : <UserRound size={34} strokeWidth={1.5} aria-hidden="true" />}
      </div>
      <div className="settings-profile__identity-text">
        <span className="settings-profile__eyebrow">Your place in AgentMux</span>
        <label htmlFor="profile-display-name">What should we call you?</label>
        <TextInput id="profile-display-name" aria-label="Display name" value={value.displayName} maxLength={USER_PROFILE_NAME_LIMIT}
          placeholder="Your name" autoComplete="nickname" onChange={event => draft.setField('displayName', event.currentTarget.value)} />
        <div className="settings-profile__image-actions">
          <button ref={photoButton} type="button" className="small-button" onClick={() => upload.current?.click()}><Camera size={13} aria-hidden="true" /> Change photo</button>
          {value.avatar && <button type="button" className="settings-profile__remove" onClick={() => draft.setField('avatar', '')}>Remove</button>}
        </div>
        <input ref={upload} hidden type="file" accept="image/png,image/jpeg" aria-label="Choose profile photo"
          onChange={event => { void chooseImage(event.currentTarget.files?.[0]); event.currentTarget.value = '' }} />
      </div>
    </section>
    {source && <section className="settings-profile__crop" aria-label="Crop profile photo">
      <header><strong>Make it yours</strong><button type="button" className="icon-button" aria-label="Cancel photo crop" onClick={() => { imageRequest.current++; setSource(null); photoButton.current?.focus() }}><X size={14} /></button></header>
      <MoteAvatarCrop key={source} source={source} canvasRef={canvas} disabled={false} onReady={() => setReady(true)} onError={setImageError} />
      <button type="button" className="small-button" disabled={!ready} onClick={useCrop}>Use this photo</button>
    </section>}
    {imageError && <p className="settings-inline-error" role="alert">{imageError}</p>}
    <section className="settings-profile__context">
      <header><h3>Working with you</h3><p>A little context makes a better collaborator.</p></header>
      <label htmlFor="profile-about">About you &amp; how you work</label>
      <ComposerTextarea id="profile-about" aria-label="About you and how you work" value={value.about} maxLength={USER_PROFILE_ABOUT_LIMIT}
        rows={6} placeholder="Your work, experience, and how you prefer agents to communicate."
        onValueChange={value => draft.setField('about', value)} />
      <div className="settings-profile__context-footer"><span>This is your context. Each Mote keeps its own role and instructions.</span><small>{value.about.length} / {USER_PROFILE_ABOUT_LIMIT}</small></div>
      <label className="settings-profile__sharing">
        <input type="checkbox" checked={value.shareWithAgents} onChange={event => draft.setField('shareWithAgents', event.currentTarget.checked)} />
        <span><strong>Share with new agents</strong><small>Your saved name and About are included when a new agent starts on this Mac. Existing conversations keep their context.</small></span>
      </label>
    </section>
    <p className="settings-profile__note">Saved locally. Your photo appears in conversations; only text is shared with new agents. Authorized agents can also read your saved profile through the settings CLI.</p>
    <SettingsSaveBar save={saveState} dirty={draft.dirty} onSave={() => void save()} />
  </div>
}
