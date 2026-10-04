import type { ComponentPropsWithRef } from 'react'

export type TextareaProps = ComponentPropsWithRef<'textarea'>

/** Native multiline presentation; controlled composition is owned by the editing adapter. */
export function Textarea({ className = '', ...props }: TextareaProps) {
  return <textarea {...props} className={`ui-input ${className}`} />
}
