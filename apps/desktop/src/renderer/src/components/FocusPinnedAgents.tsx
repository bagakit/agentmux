import { useMemo, useRef, type RefObject } from 'react'
import { IconButton } from '@agentmux/client-ui/components/IconButton'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { focusAgentPinKey, focusAgentPinLabel, setFocusAgentPinned, type FocusAgentPinGroup } from '../lib/focus-agent-pins'
import type { FocusContext } from '../lib/focus-context'
import { FocusContextStateMark } from './FocusContextState'

const Pin = semanticIconComponent('action.pin')
const Unpin = semanticIconComponent('action.unpin')
const Unavailable = semanticIconComponent('status.warning')

export function FocusPinnedAgents({ group, name, pins, contexts, filtering, onOpen, searchRef }: {
  group: FocusAgentPinGroup; name: string; pins: readonly string[]; contexts: readonly FocusContext[]; filtering: boolean
  onOpen(context: FocusContext): void; searchRef: RefObject<HTMLInputElement | null>
}) {
  const region = useRef<HTMLElement>(null)
  const entries = useMemo(() => {
    if (!pins.length) return []
    const wanted = new Set(pins), original = new Map<string, FocusContext>()
    const ambiguous = new Set<string>()
    for (const context of contexts) {
      const key = focusAgentPinKey(context)
      if (!key || !wanted.has(key)) continue
      if (original.has(key)) ambiguous.add(key)
      else original.set(key, context)
    }
    return pins.flatMap(key => {
      const context = ambiguous.has(key) ? undefined : original.get(key)
      return context || !filtering ? [{ key, context, label: context?.name ?? focusAgentPinLabel(key) }] : []
    })
  }, [pins, contexts, filtering])
  if (!entries.length) return null
  return <section ref={region} className="focus-agent-pins" aria-label={`Pinned Agents · ${name}`} data-focus-pin-group={group.scope}>
    <Pin className="focus-agent-pins__mark" size={12} aria-hidden="true" />
    <ul>
      {entries.map(({ key, context, label }) => <li key={key} data-focus-agent-pin="">
        {context ? <button type="button" className="focus-agent-pin__open" title={`${label} · ${context.workspaceName} · ${context.stateLabel}`}
          aria-label={`Open ${label} · ${context.workspaceName} · ${context.stateLabel}`} onClick={() => onOpen(context)}>
          <FocusContextStateMark context={context} /><strong>{label}</strong>
        </button> : <div className="focus-agent-pin__open" title={label}>
          <Unavailable size={13} aria-hidden="true" /><strong>{label}</strong><span>Unavailable</span>
        </div>}
        <IconButton type="button" className="focus-agent-pin__remove" aria-label={`Unpin ${label} from ${name}`} title="Unpin from group"
          onClick={event => {
            const origin = event.currentTarget, document = origin.ownerDocument
            const focused = document.activeElement === origin
            const heading = region.current?.closest('.focus-project-lanes__track')?.querySelector<HTMLButtonElement>('[data-focus-project-scope-control]')
            setFocusAgentPinned(group, key, false)
            if (focused) document.defaultView?.requestAnimationFrame(() => {
              if (origin.isConnected || document.activeElement !== document.body) return
              const target = region.current?.querySelector<HTMLButtonElement>('button.focus-agent-pin__open') ?? heading ?? searchRef.current
              target?.focus({ preventScroll: true })
            })
          }}><Unpin size={13} aria-hidden="true" /></IconButton>
      </li>)}
    </ul>
  </section>
}
