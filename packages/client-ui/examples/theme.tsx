import { useEffect, useState } from 'react'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { mountThemeRuntime, type AppAppearanceId } from '@agentmux/client-ui/theme'
import { resolveTheme } from '@agentmux/client-ui/theme/model'
import '@agentmux/client-ui/styles/semantic-icons.css'
import '@agentmux/client-ui/styles/palette.css'

export default function Theme() {
  const [appearance, setAppearance] = useState<AppAppearanceId>('dark')
  useEffect(() => mountThemeRuntime(window, { appAppearance: appearance }), [appearance])
  const theme = resolveTheme({ appAppearance: appearance })
  return <fieldset style={{ color: 'var(--text)', background: 'var(--surface-1)' }}>
    <legend>Theme and icons</legend>
    <button onClick={() => setAppearance(appearance === 'dark' ? 'light' : 'dark')}>Switch appearance</button>
    <p>Current appearance {theme.mode}</p>
    <SemanticIcon name="status.working" animation="work" aria-label="Working" />
  </fieldset>
}
