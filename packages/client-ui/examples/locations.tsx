import { useState } from 'react'
import {
  AgentWorkLocationTrigger, describeAgentWorkLocationChoices, summarizeAgentWorkLocations
} from '@agentmux/client-ui/patterns/agent-work-location'
import '@agentmux/client-ui/styles/semantic-icons.css'
import '@agentmux/client-ui/patterns/agent-work-location.css'

const views = [
  { key: 'morning', title: 'Review', detail: '', address: [{ label: 'Board', value: 'Morning' }] },
  { key: 'evening', title: 'Review', detail: '', address: [{ label: 'Board', value: 'Evening' }] }
]

export default function WorkLocations() {
  const [open, setOpen] = useState(false)
  const [known, setKnown] = useState(true)
  const [selected, setSelected] = useState(views[0]!.key)
  const summary = summarizeAgentWorkLocations(known
    ? { state: 'confirmed', positions: ['morning', 'morning', 'evening'] } : { state: 'unconfirmed' })
  return <fieldset>
    <legend>Build reviewer</legend>
    <label><input type="checkbox" checked={known} onChange={event => setKnown(event.currentTarget.checked)} /> Locations confirmed</label>
    <AgentWorkLocationTrigger agentName="Build reviewer" actionLabel="Choose work location"
      aria-expanded={open} onClick={() => setOpen(value => !value)} summary={summary}
      describeSummary={result => result.state === 'confirmed' ? result.count + ' work locations' : 'Locations unconfirmed'} />
    {open && known && <ul>{describeAgentWorkLocationChoices(views).map(({ key, title, detail }) =>
      <li key={key}><button type="button" onClick={() => { setSelected(key); setOpen(false) }}>{title} · {detail}</button></li>
    )}</ul>}
    <p role="status">Current board {selected}</p>
  </fieldset>
}
