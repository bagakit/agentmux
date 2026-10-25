import { useId, type ComponentPropsWithRef, type ReactNode } from 'react'

export type FormRowControlProps = {
  id: string
  'aria-labelledby': string
  'aria-describedby': string
}

export type FormRowProps = Omit<ComponentPropsWithRef<'label'>, 'children' | 'htmlFor'> & {
  controlId?: string
  label: ReactNode
  description: ReactNode
  children: (attributes: FormRowControlProps) => ReactNode
}

/** One native label row. The caller renders its original control and owns all field state. */
export function FormRow({ controlId, label, description, children, ...props }: FormRowProps) {
  const generatedId = useId()
  const id = controlId ?? generatedId
  const labelId = `${id}-label`, descriptionId = `${id}-description`
  return <label {...props} htmlFor={id}>
    {children({ id, 'aria-labelledby': labelId, 'aria-describedby': descriptionId })}
    <span><strong id={labelId}>{label}</strong><small id={descriptionId}>{description}</small></span>
  </label>
}
