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

/** Instructions around the original challenge. A poll never replaces the QR surface. */
export function BotSignInPrompt({ url, title, platform, scanned = false }: {
  url: string; title: string; platform: string; scanned?: boolean
}) {
  return <div className="bot-sign-in" data-sign-in-prompt>
    <BotConfirmationCode url={url} title={title} failureMessage="The sign-in code could not be displayed. Your setup is kept. Reopen this task to read its current sign-in code." />
    <div className="bot-sign-in__instructions">
      <span className="bot-task-eyebrow">On your phone</span>
      <strong>{scanned ? 'Confirm your sign-in' : `Open ${platform} and scan`}</strong>
      <p>{scanned ? 'The code has been scanned. Approve the sign-in on your phone to continue.' : 'Use the account that will manage this bot, then approve the sign-in.'}</p>
      <div className="bot-sign-in__next"><span aria-hidden="true">↳</span><p>Then return here to confirm your account and enterprise.</p></div>
    </div>
  </div>
}
