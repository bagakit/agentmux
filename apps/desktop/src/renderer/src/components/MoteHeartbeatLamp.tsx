import { useEffect, useRef, useState } from 'react'
import type { MoteWorkfaceScope } from '../lib/mote-workface'
import { useMoteHeartbeatReading, subscribeMoteHeartbeatInspection } from '../lib/mote-heartbeat-reading'
import { moteHeartbeatReadingPresentation } from '../lib/mote-heartbeat-presentation'
import { MoteQuickModeDialog } from './MoteQuickMode'
import { MoteHeartbeatGlyph } from './MoteHeartbeatGlyph'
import { useWorkbenchDocument } from '../lib/workbench-document'
import { useAppStore } from '../store'
import type { ContinuousProgressLoop } from '@agentmux/core/continuous-progress-scheduler'

/** The Mote's automatic-care arrangement, separate from its avatar and Agent status. */
export function MoteHeartbeatLamp({ scope, visible }: { scope: MoteWorkfaceScope; visible: boolean }) {
  const reading = useMoteHeartbeatReading(scope, visible), document = useWorkbenchDocument()
  const state = moteHeartbeatReadingPresentation(reading.saved, reading.unavailable)
  const [open, setOpen] = useState(false), invoker = useRef<HTMLElement | null>(null), button = useRef<HTMLButtonElement | null>(null)
  const [original, setOriginal] = useState<ContinuousProgressLoop>()
  const key = JSON.stringify(reading.target)
  useEffect(() => {
    if (!visible) return
    return subscribeMoteHeartbeatInspection(intent => {
      if (JSON.stringify(intent.target) !== key) return false
      invoker.current = document.activeElement as HTMLElement; setOriginal(intent.original); setOpen(true); return true
    })
  }, [key, visible, document])
  const close = () => { setOpen(false); reading.refresh() }
  return <>
    <button ref={button} type="button" className="mote-heartbeat-lamp" data-mote-care={state.state} title={state.detail}
      aria-label={`${scope.topic.title} · ${state.label}. Review heartbeat`} aria-haspopup="dialog" aria-expanded={open}
      onClick={event => { invoker.current = event.currentTarget; setOriginal(undefined); setOpen(true) }}>
      <span className="mote-heartbeat-lamp__signal" aria-hidden="true"><MoteHeartbeatGlyph state={state.state} /></span>
      <span className="mote-heartbeat-lamp__label">{state.label}</span>
    </button>
    {open && visible ? <MoteQuickModeDialog key={original ? JSON.stringify([original.loopId, original.pause?.episodeId, original.pendingCompletion?.operationId]) : 'current'} scope={scope} onOpenPath={path => useAppStore.getState().openFile(path, undefined, undefined, scope.workspace.id)} focusHeartbeat onClose={close}
      originalHeartbeat={original && reading.target ? { ownerHostId: reading.target.expectedResource.hostId, schedule: original } : undefined}
      returnFocus={() => invoker.current?.isConnected ? invoker.current : button.current} /> : null}
  </>
}
