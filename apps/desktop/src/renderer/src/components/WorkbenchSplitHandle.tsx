import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import { PanelResizeHandle, type ImperativePanelGroupHandle } from 'react-resizable-panels'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import { SplitRatioCommitter } from '../lib/split-ratio-commit'

/** Original panel-library gestures; only the handle is replaced when cancelling a drag. */
export function WorkbenchSplitHandle({ group, committer, sourceKey, ratio, disabled, className, onDragging }: {
  group: RefObject<ImperativePanelGroupHandle | null>
  committer: SplitRatioCommitter
  sourceKey: string
  ratio: number
  disabled: boolean
  className: string
  onDragging(active: boolean): void
}) {
  const id = useId()
  const [phase, setPhase] = useState({ generation: 0, dragging: false })
  const gesture = useRef<{ sourceKey: string; ratio: number; persisted: number } | null>(null)
  const latest = useRef({ sourceKey, ratio, disabled, onDragging })
  latest.current = { sourceKey, ratio, disabled, onDragging }

  function cancel(immediate: boolean) {
    const original = gesture.current
    if (!original) return
    gesture.current = null
    committer.cancelDragging()
    const current = latest.current
    const sameSource = original.sourceKey === current.sourceKey && original.persisted === current.ratio
    const restore = sameSource ? original.ratio : current.ratio
    const handle = document.getElementById(id)
    const returnFocus = sameSource && !current.disabled && document.activeElement === handle
    // setLayout still passes through the original onLayout owner; cancelled intermediates
    // have already been discarded, before the library's cleanup calls onDragging(false).
    group.current?.setLayout([restore * 100, (1 - restore) * 100])
    current.onDragging(false)
    const replaceHandle = () => setPhase(previous => ({ generation: previous.generation + 1, dragging: false }))
    // The library has no public cancel method. Unregistering this handle uses its own
    // stopDragging cleanup, retaining the original PanelGroup, content and terminal refs.
    if (immediate) flushSync(replaceHandle)
    else replaceHandle()
    if (returnFocus) document.getElementById(id)?.focus({ preventScroll: true })
  }
  const cancelRef = useRef(cancel)
  cancelRef.current = cancel
  useLayoutEffect(() => {
    const original = gesture.current
    if (original && (disabled || original.sourceKey !== sourceKey || original.persisted !== ratio)) cancelRef.current(false)
  }, [sourceKey, ratio, disabled])
  useEffect(() => () => { gesture.current = null; committer.cancelDragging() }, [committer])
  useEffect(() => {
    if (!phase.dragging) return
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !gesture.current || isImeOwnedKeyboardEvent(event)) return
      event.preventDefault()
      event.stopPropagation()
      // Intersecting original handles may both be dragging; each receives this event.
      cancelRef.current(true)
    }
    document.addEventListener('keydown', escape, true)
    return () => document.removeEventListener('keydown', escape, true)
  }, [phase.dragging])

  function equalize() {
    if (latest.current.disabled) return
    cancel(true)
    group.current?.setLayout([50, 50])
  }
  return <PanelResizeHandle key={phase.generation} id={id} className={className} disabled={disabled}
    aria-label="Resize split" title="Drag to resize · Double-click or Enter to equalize · Escape cancels dragging"
    onDoubleClick={event => { event.preventDefault(); equalize() }}
    onKeyDown={event => {
      if (event.key !== 'Enter' || isImeOwnedKeyboardEvent(event)) return
      event.preventDefault(); equalize()
    }}
    onDragging={active => {
      if (active) {
        const sizes = group.current?.getLayout()
        gesture.current = { sourceKey: latest.current.sourceKey, persisted: latest.current.ratio,
          ratio: sizes?.length === 2 ? sizes[0]! / 100 : latest.current.ratio }
        committer.setDragging(true)
        setPhase(previous => ({ ...previous, dragging: true }))
        latest.current.onDragging(true)
      } else {
        const original = gesture.current
        if (!original) return
        gesture.current = null
        if (latest.current.disabled || original.sourceKey !== latest.current.sourceKey || original.persisted !== latest.current.ratio) committer.cancelDragging()
        else committer.setDragging(false)
        setPhase(previous => ({ ...previous, dragging: false }))
        latest.current.onDragging(false)
      }
    }} />
}
