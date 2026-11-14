import { useState } from 'react'
import { Button } from '@agentmux/client-ui/components/Button'
import { IconButton } from '@agentmux/client-ui/components/IconButton'
import '@agentmux/client-ui/styles/buttons.css'

export default function Actions() {
  const [pinned, setPinned] = useState(false)
  const [saving, setSaving] = useState(false)
  return <fieldset>
    <legend>Review actions</legend>
    <Button aria-pressed={pinned} onClick={() => setPinned(value => !value)}>Pin the review for another person</Button>
    <IconButton aria-label="Remove pin" disabled={!pinned} onClick={() => setPinned(false)}>×</IconButton>
    <Button variant="primary" aria-busy={saving} onClick={() => setSaving(true)}>Save review</Button>
    <Button disabled={!saving} onClick={() => setSaving(false)}>Cancel save</Button>
  </fieldset>
}
