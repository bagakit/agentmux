// @vitest-environment happy-dom
import { act, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  AgentWorkLocationTrigger, describeAgentWorkLocationChoices, summarizeAgentWorkLocations,
  type AgentWorkLocationObservation, type AgentWorkLocationSummary
} from '../src/patterns/agent-work-location'

const project = 'files/p4'
const review = { title: 'Review', detail: '', address: [{ label: 'View', value: 'review' }], route: 'review', location: 'review' }
const logs = { title: 'Review', detail: '', address: [{ label: 'View', value: 'logs' }], route: 'logs', location: 'logs' }
const alias = { ...review, title: 'Project review', route: 'project-review' }
const choices = [review, logs, alias]

function describe(summary: AgentWorkLocationSummary) {
  if (summary.state === 'confirmed') return `${summary.count} open locations`
  return summary.state === 'failed' ? summary.detail : 'Locations unconfirmed'
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

it('shows zero, one, many, unconfirmed and failed reads using only host observations', async () => {
  const cases: Array<[AgentWorkLocationObservation, string]> = [
    [{ state: 'confirmed', positions: [] }, '0 open locations'],
    [{ state: 'confirmed', positions: [review.location, alias.location] }, '1 open locations'],
    [{ state: 'confirmed', positions: choices.map(choice => choice.location) }, '2 open locations'],
    [{ state: 'unconfirmed' }, 'Locations unconfirmed'],
    [{ state: 'failed', detail: 'The location source is unavailable' }, 'The location source is unavailable']
  ]
  for (const [observation, text] of cases) {
    await act(async () => root.render(<AgentWorkLocationTrigger agentName="Build agent" actionLabel="Choose location"
      summary={summarizeAgentWorkLocations(observation)} describeSummary={describe} />))
    const trigger = container.querySelector('button')!
    expect(trigger.getAttribute('aria-label')).toContain(text)
    expect(trigger.dataset.locationObservation).toBe(observation.state)
    expect(trigger.textContent).toContain(text)
  }
})

it('lets a neutral host distinguish, reject, cancel and reach original routes', async () => {
  const ownRouteSubjects = new Map(choices.map(choice => [choice.route, 'build/s7']))
  const navigate = vi.fn((subject: string, route: string) => ownRouteSubjects.get(route) === subject)
  function Viewer() {
    const trigger = useRef<HTMLButtonElement>(null)
    const [open, setOpen] = useState(false)
    const [destination, setDestination] = useState('start')
    const [issue, setIssue] = useState('')
    const cancel = () => { setOpen(false); trigger.current?.focus() }
    return <>
      <p>Execution on build · Project {project}</p>
      <textarea aria-label="Unsent draft" defaultValue="Keep the draft" />
      <AgentWorkLocationTrigger ref={trigger} agentName="Build agent" actionLabel="Choose location" aria-haspopup="dialog"
        summary={summarizeAgentWorkLocations({ state: 'confirmed', positions: choices.map(choice => choice.location) })}
        describeSummary={describe} onClick={() => { setOpen(true); setIssue('') }} />
      {open && <div role="dialog" aria-label="Locations" onKeyDown={event => { if (event.key === 'Escape') cancel() }}>
        {describeAgentWorkLocationChoices(choices).map(choice => <button type="button" key={choice.route} onClick={() => {
          if (!navigate('build/s7', choice.route)) { setIssue('This view changed Agent'); return }
          setOpen(false)
          setDestination(choice.location)
        }}><span>{choice.title}</span> <span>{choice.detail}</span></button>)}
        {issue && <p role="status">{issue}</p>}
      </div>}
      <output aria-label="Current work">{destination}</output>
    </>
  }
  await act(async () => root.render(<Viewer />))
  const trigger = container.querySelector('button[aria-haspopup]') as HTMLButtonElement
  const dialog = () => container.querySelector('[role=dialog]')
  const rows = () => [...dialog()!.querySelectorAll('button')]
  const destination = () => container.querySelector('output')?.textContent
  await act(async () => trigger.click())
  expect(new Set(rows().map(row => row.textContent)).size).toBe(3)
  expect(rows()[1]?.textContent).toContain('View logs')
  await act(async () => dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(document.activeElement).toBe(trigger)
  expect(destination()).toBe('start')
  expect(navigate).not.toHaveBeenCalled()

  ownRouteSubjects.set('logs', 'other/s7')
  await act(async () => trigger.click())
  await act(async () => rows()[1]!.click())
  expect(dialog()?.querySelector('[role=status]')?.textContent).toBe('This view changed Agent')
  expect(destination()).toBe('start')
  await act(async () => rows()[2]!.click())
  expect(navigate.mock.calls).toEqual([['build/s7', 'logs'], ['build/s7', 'project-review']])
  expect(destination()).toBe('review')
  expect(container.querySelector('textarea')?.value).toBe('Keep the draft')
  expect(container.textContent).toContain(project)
})
