import type { ComponentPropsWithRef } from 'react'

export type InputGroupProps = ComponentPropsWithRef<'div'> & { variant?: 'default' | 'prompt' }

/** One boundary for a field with adjacent actions; no extra wrapper or input state. */
export function InputGroup({ className = '', variant = 'default', ...props }: InputGroupProps) {
  return <div {...props} className={`ui-input-group${variant === 'prompt' ? ' ui-input-group--prompt' : ''} ${className}`} />
}
