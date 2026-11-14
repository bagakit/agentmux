import type { ComponentPropsWithRef } from 'react'

export type SwitchProps = Omit<ComponentPropsWithRef<'input'>, 'type' | 'role' | 'aria-checked'>

/** On/off setting with native checkbox value, focus, keyboard and form behavior. */
export function Switch({ className, ...props }: SwitchProps) {
  return <input {...props} type="checkbox" role="switch" className={className ? `ui-switch ${className}` : 'ui-switch'} />
}
