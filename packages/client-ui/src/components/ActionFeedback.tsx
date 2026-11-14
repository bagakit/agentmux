import type { ComponentPropsWithRef } from 'react'

export type ActionFeedbackProps = ComponentPropsWithRef<'div'> & { bounded?: boolean }

/** Reserve room for feedback while the caller supplies its message and announcement priority. */
export function ActionFeedback({ bounded, ...props }: ActionFeedbackProps) {
  return <div {...props} data-bounded-feedback={bounded || undefined} />
}
