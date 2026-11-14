import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useState, type ReactNode } from 'react'
import { useAppStore } from '../store'
import { useWorkbenchNameTooltip } from './WorkbenchNameTooltip'

const ThemeNavigationDownIcon = semanticIconComponent('navigation.down')
const ThemeNavigationDisclosureIcon = semanticIconComponent('navigation.disclosure')
const ThemeActionCreateIcon = semanticIconComponent('action.create')


/** Disclosure occupies the object's existing type slot, never a second gutter. */
export function SpaceDisclosure({ icon, expanded, label, disabled = false, onToggle }: {
  icon: ReactNode; expanded: boolean; label: string; disabled?: boolean; onToggle(): void
}) {
  return <button type="button" className="space-disclosure" data-space-disclosure
    aria-label={label} title={label} aria-expanded={expanded} disabled={disabled} onClick={onToggle}>
    <span className="space-disclosure__type">{icon}</span>
    <span className="space-disclosure__hint" aria-hidden="true">{expanded ? <ThemeNavigationDownIcon size={10} /> : <ThemeNavigationDisclosureIcon size={10} />}</span>
  </button>
}

/** Categories share controls; member indentation expresses category ownership, not a directory. */
export function SpaceSectionHeader({ label, count, icon, expanded, filtering, onToggle, onOpen, openLabel, opening = false,
  labelSuffix, labelHint, createLabel, onCreate, createIcon, activity, actions, selected = false, navigationId, parentNavigationId, collapsible = true, iconTargetKey }: {
  label: string; count: number; icon: ReactNode; expanded: boolean; filtering: boolean;
  onToggle(): void; onOpen?: () => void; openLabel?: string; opening?: boolean; createLabel?: string; onCreate?: (invoker: HTMLButtonElement) => Promise<unknown>; createIcon?: ReactNode;
  labelSuffix?: ReactNode; labelHint?: { name: string; detail: string };
  activity?: ReactNode; actions?: ReactNode; selected?: boolean; navigationId?: string; parentNavigationId?: string; collapsible?: boolean; iconTargetKey?: string
}) {
  const [busy, setBusy] = useState(false)
  const hint = useWorkbenchNameTooltip(labelHint?.name ?? '', labelHint?.detail ?? '', !labelHint, { pointerPassThrough: true })
  const reportError = useAppStore((state) => state.reportError)
  const canCollapse = collapsible && count > 0
  async function create(invoker: HTMLButtonElement): Promise<void> {
    setBusy(true)
    try { await onCreate?.(invoker) } catch (error) { reportError(error) } finally { setBusy(false) }
  }
  return <div className={`space-section-heading space-${label.toLowerCase()}-heading`} data-space-entry>
    {canCollapse ? <SpaceDisclosure icon={icon} expanded={expanded} label={`${expanded ? 'Collapse' : 'Expand'} ${label}`}
      disabled={filtering} onToggle={onToggle} /> : <span className="project-rail-row__icon" aria-hidden="true">{icon}</span>}
    <button type="button" className={`space-section-label space-${label.toLowerCase()}-row`}
      {...hint.props}
      aria-label={openLabel ?? (onOpen ? `${label} overview` : label)} aria-busy={opening || undefined} aria-current={selected ? 'page' : undefined}
      data-space-nav={navigationId ?? `space:${label.toLowerCase()}`} data-space-expanded={canCollapse && !filtering ? expanded : undefined}
      data-space-parent={parentNavigationId} data-space-icon-target={iconTargetKey}
      disabled={opening || (!canCollapse && !onOpen)} onClick={onOpen ?? (() => { if (!filtering) onToggle() })}>
      <strong>{label}</strong>{labelSuffix}<small>{count}</small>
    </button>
    {activity}
    {actions}
    {onCreate ? <button type="button" className="icon-button space-section-add" aria-label={createLabel} title={createLabel}
      disabled={busy} onClick={event => void create(event.currentTarget)}>{createIcon ?? <ThemeActionCreateIcon size={13} />}</button> : null}
    {hint.content}
  </div>
}
