import { useId, useState } from 'react'
import { Tabs } from '@agentmux/client-ui/components/Tabs'
import { SegmentedControl } from '@agentmux/client-ui/components/SegmentedControl'
import { SelectionIndicator } from '@agentmux/client-ui/components/SelectionIndicator'
import '@agentmux/client-ui/styles/segmented-control.css'
import '@agentmux/client-ui/styles/selection-indicator.css'

const pages = [
  { value: 'summary', label: 'Summary', body: 'Review board summary.' },
  { value: 'decisions', label: 'Decisions', body: 'Review board decisions.' },
] as const

const distances = [
  { value: 'compact', label: 'Compact' },
  { value: 'standard', label: 'Standard spacing' },
  { value: 'roomy', label: 'Extra reading room' },
] as const

export default function Selection() {
  const marker = useId()
  const [page, setPage] = useState<(typeof pages)[number]['value']>('summary')
  const [distance, setDistance] = useState<(typeof distances)[number]['value']>('standard')
  const [section, setSection] = useState('Overview')
  return <fieldset>
    <legend>Review board</legend>
    <Tabs aria-label="Review board sections" value={page} onValueChange={setPage} options={pages.map(item => ({
      value: item.value, label: item.label, panelId: `${marker}-${item.value}`, button: { id: `${marker}-tab-${item.value}` },
    }))} />
    {pages.map(item => <div key={item.value} id={`${marker}-${item.value}`} role="tabpanel" tabIndex={0}
      aria-labelledby={`${marker}-tab-${item.value}`} hidden={page !== item.value}>{item.body}</div>)}
    <SegmentedControl aria-label="Reading spacing" value={distance} onValueChange={setDistance} options={distances} />
    <nav aria-label="Reading position" style={{ position: 'relative', isolation: 'isolate', display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-2)' }}>
      <SelectionIndicator />
      {['Overview', 'Original decisions'].map(label => <button key={label} type="button" aria-current={section === label ? 'location' : 'false'}
        style={{ border: 0, background: 'transparent', color: 'inherit', padding: 'var(--sp-2)' }} onClick={() => setSection(label)}>{label}</button>)}
    </nav>
  </fieldset>
}
