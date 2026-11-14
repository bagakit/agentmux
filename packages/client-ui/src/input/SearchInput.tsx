import { useImperativeHandle, useRef } from 'react'
import { IconButton } from '../components/IconButton.js'
import { isImeOwnedKeyboardEvent } from '../lib/ime-keyboard-event.js'
import { SemanticIcon } from '../theme/icons.js'
import { InputGroup } from './InputGroup.js'
import { TextInput, type TextInputProps } from './TextInput.js'

export type SearchInputProps = Omit<TextInputProps, 'type' | 'defaultValue' | 'value' | 'onChange' | 'aria-label'> & {
  'aria-label': string
  value: string
  clearLabel: string
  onValueChange(value: string): void
}

/** A native search field with an explicit clear action. The caller owns the query and its results. */
export function SearchInput({ className, ref, value, clearLabel, onValueChange, onKeyDown, ...props }: SearchInputProps) {
  const input = useRef<HTMLInputElement>(null)
  useImperativeHandle(ref, () => input.current!, [])
  return <InputGroup className={className ? `ui-search-field ${className}` : 'ui-search-field'} onClick={event => {
    if (event.target === event.currentTarget) input.current?.focus()
  }}>
    <SemanticIcon name="action.search" size={14} aria-hidden="true" />
    <TextInput {...props} ref={input} type="search" value={value} onChange={event => onValueChange(event.currentTarget.value)}
      onKeyDown={event => {
        if (isImeOwnedKeyboardEvent(event)) { event.stopPropagation(); return }
        onKeyDown?.(event)
      }} />
    {value && !props.disabled && !props.readOnly ? <IconButton className="ui-search-clear" aria-label={clearLabel}
      onClick={() => { input.current?.focus({ preventScroll: true }); onValueChange('') }}>
      <SemanticIcon name="action.clear" size={13} aria-hidden="true" />
    </IconButton> : null}
  </InputGroup>
}
