import { ChevronDown, ChevronRight, Plus } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useAppStore } from '../store'

/** Disclosure occupies the object's existing type slot, never a second gutter. */
export function SpaceDisclosure({ icon, expanded, label, disabled = false, onToggle }: {
  icon: ReactNode; expanded: boolean; label: string; disabled?: boolean; onToggle(): void
}) {
  return <button type="button" className="space-disclosure" data-space-disclosure
    aria-label={label} title={label} aria-expanded={expanded} disabled={disabled} onClick={onToggle}>
    <span className="space-disclosure__type">{icon}</span>
    <span className="space-disclosure__hint" aria-hidden="true">{expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}</span>
  </button>
}

/** Categories share controls; they do not add a directory level to their members. */
export function SpaceSectionHeader({ label, count, icon, expanded, filtering, onToggle, onOpen,
  createLabel, onCreate, activity, selected = false }: {
  label: string; count: number; icon: ReactNode; expanded: boolean; filtering: boolean;
  onToggle(): void; onOpen?: () => void; createLabel: string; onCreate(): Promise<unknown>;
  activity?: ReactNode; selected?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const reportError = useAppStore((state) => state.reportError)
  const canCollapse = count > 0
  async function create(): Promise<void> {
    setBusy(true)
    try { await onCreate() } catch (error) { reportError(error) } finally { setBusy(false) }
  }
  return <div className={`space-section-heading space-${label.toLowerCase()}-heading`} data-space-entry>
    {canCollapse ? <SpaceDisclosure icon={icon} expanded={expanded} label={`${expanded ? 'Collapse' : 'Expand'} ${label}`}
      disabled={filtering} onToggle={onToggle} /> : <span className="project-rail-row__icon" aria-hidden="true">{icon}</span>}
    <button type="button" className={`space-section-label space-${label.toLowerCase()}-row`}
      aria-label={onOpen ? `${label} overview` : label} aria-current={selected ? 'page' : undefined}
      data-space-nav={`space:${label.toLowerCase()}`} data-space-expanded={canCollapse && !filtering ? expanded : undefined}
      disabled={!canCollapse && !onOpen} onClick={onOpen ?? (() => { if (!filtering) onToggle() })}>
      <strong>{label}</strong><small>{count}</small>
    </button>
    {activity}
    <button type="button" className="icon-button space-section-add" aria-label={createLabel} title={createLabel}
      disabled={busy} onClick={() => void create()}><Plus size={13} /></button>
  </div>
}
