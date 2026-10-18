import { useId, useRef, useState } from 'react'
import { TextInput } from '@agentmux/client-ui/input'
import { TOOLKIT_ICON_OPTIONS, findToolkitIcon, type ToolkitIconId } from '../../../../shared/toolkit-preferences'
import { ToolkitIcon, toolkitIconLabels } from './ToolkitIcon'
import './toolkit-icon-picker.css'

const groups = [...new Set(TOOLKIT_ICON_OPTIONS.map(option => option.group))]

export function ToolkitIconPicker({ icon, onChange }: { icon: string; onChange(icon: ToolkitIconId): void }) {
  const id = useId(), picker = useRef<HTMLDetailsElement>(null)
  const [query, setQuery] = useState('')
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean)
  const options = TOOLKIT_ICON_OPTIONS.filter(option => {
    const text = `${toolkitIconLabels[option.value]} ${option.value} ${option.semanticId} ${option.keywords}`.toLocaleLowerCase()
    return terms.every(term => text.includes(term))
  })
  const selected = findToolkitIcon(icon)
  const selectedLabel = selected ? toolkitIconLabels[selected.value] : icon
  return <details ref={picker} className="toolkit-icon-picker" onKeyDown={event => {
    if (event.key !== 'Escape' || event.nativeEvent.isComposing || event.keyCode === 229 || !picker.current?.open) return
    event.preventDefault(); event.stopPropagation()
    picker.current.open = false
    picker.current.querySelector('summary')?.focus()
  }}>
    <summary aria-label="Choose tool icon" title={selectedLabel}><ToolkitIcon icon={icon} size={20} /><span>Icon</span></summary>
    <div className="toolkit-icon-picker__panel">
      <div className="toolkit-icon-picker__current"><span>Current icon</span><strong><ToolkitIcon icon={icon} size={14} />{selectedLabel}</strong></div>
      <TextInput type="search" aria-label="Search tool icons" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search icons…" />
      <div className="toolkit-icon-picker__options">
        {groups.map(group => {
          const choices = options.filter(option => option.group === group)
          return choices.length ? <fieldset key={group}><legend>{group}</legend><div className="toolkit-icon-picker__grid">
            {choices.map(option => <label key={option.value} data-selected={icon === option.value} title={`${toolkitIconLabels[option.value]} · ${option.value}`}>
              <input type="radio" name={`${id}-icon`} value={option.value} checked={icon === option.value}
                aria-label={toolkitIconLabels[option.value]} onChange={() => onChange(option.value)} />
              <ToolkitIcon icon={option.value} size={16} /><span>{toolkitIconLabels[option.value]}</span>
            </label>)}
          </div></fieldset> : null
        })}
        {options.length === 0 ? <p className="toolkit-icon-picker__empty" role="status">No matching icons. Try another name or purpose.</p> : null}
      </div>
    </div>
  </details>
}
