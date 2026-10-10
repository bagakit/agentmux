import { Component, type ReactNode } from 'react'
import { QRCodeSVG } from 'qrcode.react'

class ConfirmationBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? <p role="status" className="settings-group-note">The code could not be displayed. Open the confirmation page instead.</p> : this.props.children }
}
/** Only renders the original public challenge; it owns no registration or polling. */
export function BotConfirmationCode({ url }: { url: string }) {
  return <ConfirmationBoundary key={url}><div className="connector-enrollment__code" data-enrollment-code><QRCodeSVG value={url} size={232} level="M" marginSize={4} bgColor="#ffffff" fgColor="#111715" title="Bot application confirmation" role="img" /></div></ConfirmationBoundary>
}
