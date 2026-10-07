import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useState } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'

const ThemeStatusLoadingIcon = semanticIconComponent('status.loading')
const ThemeStatusSavedIcon = semanticIconComponent('status.saved')


export function useSettingsSave() {
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [error, setError] = useState('')

  async function run(operation: () => Promise<void>): Promise<boolean> {
    setState('saving')
    setError('')
    try {
      await operation()
      setState('saved')
      return true
    } catch (cause) {
      setError(presentError(cause))
      setState('error')
      return false
    }
  }

  return { state, error, saving: state === 'saving', run }
}

export function SettingsSaveBar({ save, dirty, label = 'Save changes', onSave, disabled = false }: {
  save: ReturnType<typeof useSettingsSave>
  dirty: boolean
  label?: string
  onSave: () => void
  disabled?: boolean
}) {
  return (
    <div className="settings-pane-actions" data-settings-save-bar>
      <span className={`settings-save-feedback ${save.error ? 'settings-inline-error' : ''}`} role={save.error ? 'alert' : 'status'}>
        {save.error ? save.error : save.saving ? <><ThemeStatusLoadingIcon className="spin" size={13} /> Saving changes…</> : dirty ? 'Unsaved changes' : save.state === 'saved' ? <><ThemeStatusSavedIcon size={13} /> Changes saved</> : 'All changes saved'}
      </span>
      <button className="primary-button" aria-busy={save.saving} disabled={save.saving || !dirty || disabled} onClick={onSave}>{label}</button>
    </div>
  )
}
