import type { ComponentPropsWithRef } from 'react'

export type TextInputProps = Omit<ComponentPropsWithRef<'input'>, 'type'> & {
  type?: 'text' | 'search' | 'email' | 'url' | 'tel' | 'password' | 'number' | 'date' | 'time' | 'datetime-local' | 'month' | 'week'
}

/** Native text field. The caller owns its value, validation and actions. */
export function TextInput({ className = '', type = 'text', ...props }: TextInputProps) {
  return <input {...props} type={type} className={`ui-input ${className}`} />
}
