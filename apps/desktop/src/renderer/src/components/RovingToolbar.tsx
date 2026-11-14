import * as RovingFocus from '@radix-ui/react-roving-focus'
import type { ComponentPropsWithoutRef } from 'react'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'

export const RovingToolbarItem = RovingFocus.Item

/** Native buttons keep their actions; the maintained primitive owns only group focus. */
export function RovingToolbar(props: ComponentPropsWithoutRef<'div'>) {
  return <RovingFocus.Root asChild orientation="horizontal" loop><div {...props} role="toolbar" onKeyDownCapture={event => {
    props.onKeyDownCapture?.(event)
    if (isImeOwnedKeyboardEvent(event.nativeEvent)) event.stopPropagation()
  }} /></RovingFocus.Root>
}

export function RovingToolbarButton(props: ComponentPropsWithoutRef<'button'>) {
  return <RovingToolbarItem asChild focusable={!props.disabled} active={props['aria-pressed'] === true}>
    <button {...props} />
  </RovingToolbarItem>
}
