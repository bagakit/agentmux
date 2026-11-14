import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as Dialog from '@agentmux/client-ui/components/Modal'
import { autoUpdate, computePosition, flip, offset, shift, size } from '@floating-ui/dom'
import { moteWorkEvents } from '@agentmux/client-ui/components/MoteConversationThreads'
import type { MoteDialogueLink } from '@agentmux/core/mote-dialogue'
import { DocumentOverlayPortal } from './WindowOverlayHost'
import type { MoteWorkingMember } from './MoteThreadNavigation'

/** Activity belongs to the exact actor. Listed events remain associated history, not inferred running tasks. */
export function MoteActiveWorkShortcut({ links, members, onOpen }: {
  links: readonly MoteDialogueLink[]; members: readonly MoteWorkingMember[]; onOpen(eventId: string): void
}) {
  const groups = useMemo(() => {
    const events = moteWorkEvents(links)
    return members.flatMap(member => {
      const related = events.filter(event => event.sources.some(source => source.origin.hostId === member.hostId && source.origin.recipientSessionId === member.agentSessionId))
      return related.length ? [{ member, events: related }] : []
    })
  }, [links, members])
  const [open, setOpen] = useState(false), [panel, setPanel] = useState<HTMLDivElement | null>(null)
  const [choices, setChoices] = useState(groups)
  const shown = open ? choices : groups
  const trigger = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    const anchor = trigger.current
    if (!open || !panel || !anchor) return
    let current = true
    const release = autoUpdate(anchor, panel, () => { void computePosition(anchor, panel, { strategy: 'fixed', placement: 'bottom-end',
      middleware: [offset(6), flip(), shift({ padding: 12 }), size({ padding: 12, apply: ({ availableHeight, availableWidth }) => {
        if (current) Object.assign(panel.style, { maxHeight: `${Math.min(360, Math.max(0, availableHeight))}px`, maxWidth: `${Math.max(0, availableWidth)}px` })
      } })] }).then(result => { if (current) Object.assign(panel.style, { left: `${result.x}px`, top: `${result.y}px`, visibility: 'visible' }) }) })
    return () => { current = false; release() }
  }, [open, panel])
  if (!groups.length && !open) return null
  return <Dialog.Root modal={false} open={open} onOpenChange={next => { if (next) setChoices(groups); setOpen(next) }}>
    <div className="mote-active-work" data-mote-active-work>
      <Dialog.Trigger asChild><button type="button" className="small-button mote-active-work__trigger" ref={trigger} aria-label="工作中的成员" title="查看正在工作的成员及其关联工作">工作中 <span>{groups.length}</span><span aria-hidden="true">↗</span></button></Dialog.Trigger>
    </div>
    <DocumentOverlayPortal component={Dialog.Portal}><Dialog.Content ref={setPanel} className="mote-active-work__popover" style={{ visibility: 'hidden' }} aria-describedby={undefined}>
      <header><Dialog.Title>工作中的成员</Dialog.Title><Dialog.Close className="icon-button" aria-label="关闭工作快跳">×</Dialog.Close></header>
      <p title="保留打开时的关联项；成员活动不代表每项历史工作正在执行。">相关工作记录</p>
      {shown.map(({ member, events }) => <section key={JSON.stringify([member.hostId, member.agentSessionId])}><strong title={member.title}>{member.title}</strong>
        <small>{groups.some(group => group.member.hostId === member.hostId && group.member.agentSessionId === member.agentSessionId) ? '正在工作' : '当前工作状态未确认，原工作仍可打开'}</small>
        {events.map((event, index) => <button type="button" className="small-button" key={event.id} data-mote-work-jump={event.id} onClick={() => { setOpen(false); onOpen(event.id) }}>
          <span>{events.length === 1 ? '打开关联工作' : `关联工作 ${index + 1}`}</span><time>{event.at === null ? '时间未确认' : new Date(event.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time><span aria-hidden="true">↗</span>
        </button>)}
      </section>)}
    </Dialog.Content></DocumentOverlayPortal>
  </Dialog.Root>
}
