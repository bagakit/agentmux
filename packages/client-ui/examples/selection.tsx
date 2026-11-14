import { useId, useState } from 'react'
import { Tabs } from '@agentmux/client-ui/components/Tabs'
import { SegmentedControl } from '@agentmux/client-ui/components/SegmentedControl'
import '@agentmux/client-ui/styles/segmented-control.css'

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
  return <fieldset>
    <legend>Review board</legend>
    <Tabs aria-label="Review board sections" value={page} onValueChange={setPage} options={pages.map(item => ({
      value: item.value, label: item.label, panelId: `${marker}-${item.value}`, button: { id: `${marker}-tab-${item.value}` },
    }))} />
    {pages.map(item => <div key={item.value} id={`${marker}-${item.value}`} role="tabpanel" tabIndex={0}
      aria-labelledby={`${marker}-tab-${item.value}`} hidden={page !== item.value}>{item.body}</div>)}
    <SegmentedControl aria-label="Reading spacing" value={distance} onValueChange={setDistance} options={distances} />
  </fieldset>
}
