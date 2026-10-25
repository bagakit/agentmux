import type { ComponentPropsWithRef } from 'react'

export type IconButtonProps = Omit<ComponentPropsWithRef<'button'>, 'aria-label'> & {
  'aria-label': string
  intent?: 'neutral' | 'danger'
}

/** A named native icon action. Explicit title and native interaction props remain with the caller. */
export function IconButton({ 'aria-label': label, intent = 'neutral', type = 'button', title = label, className = '', ...props }: IconButtonProps) {
  return <button {...props} type={type} aria-label={label} title={title}
    className={['icon-button', intent === 'danger' ? 'icon-button--danger' : '', className].filter(Boolean).join(' ')} />
}
