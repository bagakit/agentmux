import { useState } from 'react'
import { MobileConversationSurface, type MobileConversationSurfaceProps } from '../src/conversation/MobileConversationSurface'

/** Standalone consumers use the same separate header slot as the mobile shell. */
export function MobileConversationHeaderFixture(props: Omit<MobileConversationSurfaceProps, 'toolbarTarget'>) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null)
  return <><header><div ref={setTarget} /></header><MobileConversationSurface {...props} toolbarTarget={target} /></>
}
