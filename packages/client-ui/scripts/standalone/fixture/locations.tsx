import { useEffect, useRef, useState } from 'react'
import { Button } from '@agentmux/client-ui/components/Button'
import { AgentWorkLocationTrigger, describeAgentWorkLocationChoices, summarizeAgentWorkLocations } from '@agentmux/client-ui/patterns/agent-work-location'

type Agent = 'Mira' | 'Niko'
type Route = { route: string; position: string; title: string; detail: string; address: readonly { label: string; value: string }[] }
type Check = { agent: Agent; route: string }
const routes: Record<Agent, readonly Route[]> = {
  Mira: [
    { route: 'brief', position: 'review', title: 'Review', detail: 'Working board', address: [{ label: 'Entrance', value: 'Brief' }] },
    { route: 'recent', position: 'review', title: 'Review', detail: 'Working board', address: [{ label: 'Entrance', value: 'Recent' }] },
    { route: 'logs', position: 'logs', title: 'Review', detail: 'Working board', address: [{ label: 'Entrance', value: 'Logs' }] },
  ],
  Niko: [
    { route: 'notes', position: 'notes', title: 'Notes', detail: 'Working board', address: [{ label: 'Entrance', value: 'Notebook' }] },
  ],
}

export function Locations() {
  const [agent, setAgent] = useState<Agent>('Mira')
  const [known, setKnown] = useState(true)
  const [open, setOpen] = useState(false)
  const [work, setWork] = useState('original-board')
  const [status, setStatus] = useState('')
  const [rebound, setRebound] = useState(false)
  const request = useRef<Check | null>(null)
  const active = useRef<Check | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const chooser = useRef<HTMLElement>(null)
  const destination = useRef<HTMLOutputElement>(null)
  useEffect(() => { if (open) chooser.current?.querySelector('button')?.focus() }, [open])
  const choices = describeAgentWorkLocationChoices(known ? routes[agent] : [])
  const summary = summarizeAgentWorkLocations(known
    ? { state: 'confirmed', positions: choices.map(choice => choice.position) }
    : { state: 'unconfirmed' })

  function cancel() {
    active.current = null
    setOpen(false)
    trigger.current?.focus()
  }
  function choose(choice: Route) {
    const route = choice.route
    const check = { agent, route }
    active.current = check
    request.current = check
    setStatus('Checking selected view')
  }
  function deliver() {
    const check = request.current
    request.current = null
    if (!check || check !== active.current) return
    active.current = null
    const target = routes[check.agent].find(route => route.route === check.route)
    if (!target || rebound && check.agent === 'Mira' && check.route === 'logs') {
      setStatus('The selected view changed Agent')
      return
    }
    setWork(`${check.agent}/${target.position}/${target.route}`)
    setStatus('Selected view opened')
    setOpen(false)
    destination.current?.focus()
  }

  return <section aria-label="Work locations">
    <Button id="switch-agent" onClick={() => {
      active.current = null
      setStatus('')
      setOpen(false)
      setAgent(agent === 'Mira' ? 'Niko' : 'Mira')
    }}>Show {agent === 'Mira' ? 'Niko' : 'Mira'}</Button>
    <Button id="toggle-observation" onClick={() => { active.current = null; setKnown(!known) }}>Toggle observations</Button>
    <AgentWorkLocationTrigger id="location-trigger" ref={trigger} agentName={agent} actionLabel="Choose location"
      aria-haspopup="dialog" aria-expanded={open} summary={summary}
      describeSummary={value => value.state === 'confirmed' ? `${value.count} open locations` : 'Locations unconfirmed'}
      onClick={() => { setOpen(true); setStatus('') }} />
    {open ? <section ref={chooser} id="location-chooser" role="dialog" aria-label="Choose an exact view" onKeyDown={event => {
      if (event.key === 'Escape') cancel()
    }}>
      {choices.map(choice => <Button key={choice.route} data-route={choice.route} onClick={() => choose(choice)}>
        {choice.title} · {choice.detail}
      </Button>)}
      <Button id="cancel-location" onClick={cancel}>Cancel</Button>
    </section> : null}
    <Button id="deliver-location" onClick={deliver}>Deliver location check</Button>
    <Button id="rebind-location" onClick={() => setRebound(true)}>Move Logs to another Agent</Button>
    <output id="location-status" role="status">{status}</output>
    <output ref={destination} tabIndex={-1} id="destination">{work}</output>
    <label>Retained working draft <input id="work-draft" defaultValue="Keep the original board draft" /></label>
  </section>
}
