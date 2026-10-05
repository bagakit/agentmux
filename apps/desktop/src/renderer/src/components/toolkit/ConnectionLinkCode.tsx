import { Component, type ReactNode } from 'react'
import { QRCodeSVG } from 'qrcode.react'

class CodeBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? <p role="status">Code unavailable. Copy the connection link below.</p> : this.props.children }
}

/** Local encoding of the exact owner-issued URL, including its offer fragment. */
export function ConnectionLinkCode({ url }: { url: string }) {
  return <div className="connection-link-code"><CodeBoundary key={url}>
    <QRCodeSVG value={url} size={232} level="M" marginSize={4} bgColor="#ffffff" fgColor="#111715" title="Phone connection QR code" role="img" />
  </CodeBoundary></div>
}
