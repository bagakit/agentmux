import { Button } from '@agentmux/client-ui/components/Button'
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

/**
 * `dirty` says whether the draft differs from what is saved; `blocked` says why it cannot be saved
 * yet. They are separate facts: an unsaved draft that cannot be saved is still unsaved, never
 * "All changes saved".
 */
export function SettingsSaveBar({ save, dirty, label = 'Save changes', onSave, blocked }: {
  save: ReturnType<typeof useSettingsSave>
  dirty: boolean
  label?: string
  onSave: () => void
  blocked?: string | undefined
}) {
  const reason = dirty ? blocked?.trim() : undefined
  return (
    <div className="settings-pane-actions" data-settings-save-bar data-settings-save-blocked={reason ? '' : undefined}>
      <span className={`settings-save-feedback ${save.error ? 'settings-inline-error' : ''}`} role={save.error ? 'alert' : 'status'}>
        {save.error ? save.error : save.saving ? <><ThemeStatusLoadingIcon animation="spin" size={13} /> Saving changes…</> : reason ? `Can’t save yet — ${reason}` : dirty ? 'Unsaved changes' : save.state === 'saved' ? <><ThemeStatusSavedIcon size={13} /> Changes saved</> : 'All changes saved'}
      </span>
      <Button variant="primary" aria-busy={save.saving} disabled={save.saving || !dirty || Boolean(reason)} onClick={onSave}>{label}</Button>
    </div>
  )
}
