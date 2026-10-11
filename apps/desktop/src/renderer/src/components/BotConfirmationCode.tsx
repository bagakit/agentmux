import { Component, type ReactNode } from 'react'
import { QRCodeSVG } from 'qrcode.react'

class ConfirmationBoundary extends Component<{ children: ReactNode; failureMessage?: string }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? <p role="status" className="settings-group-note">{this.props.failureMessage ?? 'The code could not be displayed. Open the confirmation page instead.'}</p> : this.props.children }
}
/** Only renders the original public challenge; it owns no registration or polling. */
export function BotConfirmationCode({ url, title = 'Bot application confirmation', failureMessage }: { url: string; title?: string; failureMessage?: string }) {
  return <ConfirmationBoundary key={url} {...(failureMessage === undefined ? {} : { failureMessage })}><div className="connector-enrollment__code" data-enrollment-code><QRCodeSVG value={url} size={232} level="M" marginSize={4} bgColor="#ffffff" fgColor="#111715" title={title} role="img" /></div></ConfirmationBoundary>
}
