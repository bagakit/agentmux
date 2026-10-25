import type { ComponentPropsWithRef } from 'react'

export type ButtonVariant = 'secondary' | 'primary' | 'danger'
export type ButtonProps = ComponentPropsWithRef<'button'> & { variant?: ButtonVariant }
const classes: Record<ButtonVariant, string> = { secondary: 'small-button', primary: 'primary-button', danger: 'danger-button' }

/** Native action presentation. The caller owns availability, busy state and the operation. */
export function Button({ variant = 'secondary', type = 'button', className = '', ...props }: ButtonProps) {
  return <button {...props} type={type} className={[classes[variant], className].filter(Boolean).join(' ')} />
}
