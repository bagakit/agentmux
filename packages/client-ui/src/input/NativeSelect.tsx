import type { ComponentPropsWithRef } from 'react'

export type NativeSelectProps = ComponentPropsWithRef<'select'>

/** A native select with the shared field surface and the platform's option interaction. */
export function NativeSelect({ className = '', ...props }: NativeSelectProps) {
  return <select {...props} className={`ui-input ${className}`} />
}
