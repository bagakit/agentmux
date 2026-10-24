import type { ElementType } from 'react'
/** The private fixture has one document; the actual menu keeps its Radix owner and behavior. */
export function DocumentOverlayPortal({ component: Component, container, ...props }: { component: ElementType; container?: Element; [key: string]: unknown }) {
  return <Component container={container ?? document.body} {...props} />
}
/** All identities supply their original client avatar explicitly, as the public API permits. */
export function ConversationMessageAvatar(): never { throw new Error('The focused client must supply its original configured avatar') }
