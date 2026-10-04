import type { ComponentPropsWithRef } from 'react'

export type InputGroupProps = ComponentPropsWithRef<'div'>

/** One boundary for a field with adjacent actions; no extra wrapper or input state. */
export function InputGroup({ className = '', ...props }: InputGroupProps) {
  return <div {...props} className={`ui-input-group ${className}`} />
}
