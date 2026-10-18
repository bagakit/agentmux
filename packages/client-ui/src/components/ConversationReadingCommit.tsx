import { Component, type ReactNode } from 'react'
import type { ConversationBodyWork } from '../lib/conversation-body-work.js'

type Props = { work: ConversationBodyWork; preserve: boolean; children: ReactNode }

/** Read the actual position after concurrent rendering, immediately before DOM mutation. */
export class ConversationReadingCommit extends Component<Props, object, boolean> {
  getSnapshotBeforeUpdate(): boolean {
    if (!this.props.preserve) return false
    this.props.work.capture(true)
    return true
  }
  componentDidUpdate(_previous: Props, _state: object, captured: boolean): void {
    if (captured) this.props.work.restore()
  }
  render(): ReactNode { return this.props.children }
}
