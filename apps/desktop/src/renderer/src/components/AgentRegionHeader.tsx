import { History, MoreHorizontal } from 'lucide-react'
import * as DropdownMenu from './HoverDropdownMenu'
import { RegionMenuEntryView, useRegionMenuEntries } from './RegionContextMenu'

/** SessionPane owns identity/reading; layout and address actions arrive already bound to the Region. */
export function AgentRegionHeader({ name, executorLabel, sessionId, regionId, readOnly, onHistory }: {
  name: string
  executorLabel: string
  sessionId: string
  regionId: string | undefined
  readOnly: boolean
  onHistory: (() => void) | undefined
}) {
  const entries = useRegionMenuEntries()
  return <header className="agent-region-header"
    aria-label={`Agent ${name}; ${readOnly ? 'Read-only; ' : ''}${executorLabel}; Session ${sessionId}`}>
    <strong className="agent-region-header__name" title={name}>{name}</strong>
    {readOnly ? <span className="agent-region-header__mode">Read-only</span> : null}
    <span className="agent-region-header__meta" title={`${executorLabel}; Session ${sessionId}`}>
      {executorLabel} · {sessionId.slice(0, 8)}
    </span>
    {onHistory || entries.length > 0 ? <DropdownMenu.Root>
      <DropdownMenu.Trigger className="agent-region-header__more" title="More actions"
        aria-label={`More actions for ${name}`} onPointerDown={(event) => event.stopPropagation()}>
        <MoreHorizontal size={14} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal><DropdownMenu.Content className="tab-context-menu agent-region-menu"
        data-owner-region-id={regionId} data-agent-session-id={sessionId} side="bottom" align="end" sideOffset={4} collisionPadding={8}
        onPointerDown={(event) => event.stopPropagation()}>
        {onHistory ? <><DropdownMenu.Item className="tab-context-menu__item" onSelect={onHistory}>
          <History size={14} /><span>Conversation history</span>
        </DropdownMenu.Item>{entries.length > 0 ? <DropdownMenu.Separator className="tab-context-menu__separator" /> : null}</> : null}
        {entries.map((entry, index) => <RegionMenuEntryView key={index} entry={entry} index={index}
          Item={DropdownMenu.Item} Separator={DropdownMenu.Separator} />)}
      </DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root> : null}
  </header>
}
