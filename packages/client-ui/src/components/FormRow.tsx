import { useId, type ComponentPropsWithRef, type ReactNode } from 'react'

export type FormRowControlProps = {
  id: string
  'aria-labelledby': string
  'aria-describedby'?: string
  'aria-invalid'?: true
}

export type FormRowProps = Omit<ComponentPropsWithRef<'label'>, 'children' | 'htmlFor'> & {
  controlId?: string
  label: ReactNode
  description?: ReactNode
  error?: string | null
  invalid?: boolean
  layout?: 'inline' | 'stacked'
  children: (attributes: FormRowControlProps) => ReactNode
}

/** The native field and its message IDs stay paired. The caller owns the value and validation. */
export function FormRow({ controlId, label, description, error, invalid, layout = 'inline', className, children, ...props }: FormRowProps) {
  const generatedId = useId()
  const id = controlId ?? generatedId
  const labelId = `${id}-label`, descriptionId = `${id}-description`, errorId = `${id}-error`
  const hasDescription = description != null
  const descriptions = [hasDescription ? descriptionId : '', error ? errorId : ''].filter(Boolean).join(' ')
  const control = children({ id, 'aria-labelledby': labelId,
    ...(descriptions ? { 'aria-describedby': descriptions } : {}), ...(invalid ? { 'aria-invalid': true } : {}) })
  const heading = <strong id={labelId}>{label}</strong>
  const messages = <>
    {hasDescription ? <small id={descriptionId}>{description}</small> : null}
    {error ? <small id={errorId} role="alert">{error}</small> : null}
  </>
  const classes = [layout === 'stacked' ? 'ui-form-row--stacked' : '', className].filter(Boolean).join(' ')
  return <label {...props} htmlFor={id} className={classes}>{layout === 'stacked' ? <>
    {heading}{control}{messages}
  </> : <>{control}<span>{heading}{messages}</span></>}</label>
}
