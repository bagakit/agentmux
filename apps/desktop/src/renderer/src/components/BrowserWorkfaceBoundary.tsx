import { Component, Fragment, useEffect, useState, type ReactNode, type RefObject } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { api } from '../lib/api'
import type { BrowserWorkbenchSurface } from '../lib/workbench-tabs'
import { useAppStore } from '../store'
import { StableWorkbenchView } from './StableWorkbenchView'
import type { WorkbenchBrowserPresentation } from './BrowserPresentationStage'

/** Only the original address draft crosses a failed Renderer tree. No page state does. */
export type BrowserWorkfaceAddressDraft = { browserId: string; value: string; edited: boolean }
type Props = {
  tab: BrowserWorkbenchSurface
  addressDraft: RefObject<BrowserWorkfaceAddressDraft>
  presentationTargetId?: string | undefined
  presentations?: readonly WorkbenchBrowserPresentation[] | undefined
  onRegionClose?: (() => void) | undefined
  children: ReactNode
}

/** A Browser rendering fault cannot take down another Region or its healthy Run. */
export class BrowserWorkfaceBoundary extends Component<Props, { failure: string | null; revision: number }> {
  state = { failure: null as string | null, revision: 0 }
  static getDerivedStateFromError(error: unknown) {
    return { failure: presentError(error) }
  }
  private retry = () => this.setState(state => ({ failure: null, revision: state.revision + 1 }))
  render(): ReactNode {
    if (this.state.failure === null) return <Fragment key={this.state.revision}>{this.props.children}</Fragment>
    const { tab, addressDraft, presentationTargetId, presentations = [], onRegionClose } = this.props
    const primary = presentations.find(presentation => presentation.target.hostId === presentationTargetId) ?? presentations[0]
    const content = (presentation?: WorkbenchBrowserPresentation) => <BrowserRenderingFailure
      tab={tab} addressDraft={addressDraft} failure={this.state.failure!} retry={this.retry} onRegionClose={onRegionClose}
      survey={presentation?.target.surface === 'survey'} />
    return <>
      {content(primary)}
      {presentations.filter(presentation => presentation !== primary).map(presentation => <StableWorkbenchView
        key={presentation.occurrence.presentationId} kind="region" homeId={`${presentation.stageHostId}:parked`}
        targetId={presentation.stageHostId} reference={presentation.occurrence.location}
        active={presentation.active} visible={presentation.visible} retainedRegionId={presentation.occurrence.location.regionId}>
        <section className="workbench-region" data-workbench-region-id={presentation.occurrence.location.regionId}>
          {content(presentation)}
        </section>
      </StableWorkbenchView>)}
    </>
  }
}

function BrowserRenderingFailure({ tab, addressDraft, failure, retry, onRegionClose, survey }: {
  tab: BrowserWorkbenchSurface; addressDraft: RefObject<BrowserWorkfaceAddressDraft>; failure: string; retry: () => void
  onRegionClose?: (() => void) | undefined; survey: boolean
}) {
  const [address, setAddress] = useState(addressDraft.current.value)
  const [actionError, setActionError] = useState<string | null>(null)
  useEffect(() => { if (!addressDraft.current.edited) setAddress(addressDraft.current.value) }, [tab.url, addressDraft])
  return <section className={`browser-surface${survey ? ' browser-surface--survey' : ''}`}>
    <form className="browser-toolbar" onSubmit={event => { event.preventDefault(); retry() }}>
      <label><input aria-label="Browser address" value={address} onChange={event => {
        const value = event.target.value
        addressDraft.current.value = value; addressDraft.current.edited = true; setAddress(value)
      }} /></label>
      {onRegionClose ? <button type="button" aria-label="Close split" title="Close split" onClick={onRegionClose}>×</button> : null}
    </form>
    <div className="pane-state pane-state--error" role="status">
      <strong>Browser view could not display</strong>
      <span>The Browser view failed: {failure || 'No further detail was reported.'}</span>
      <span>The original page, URL and profile are kept. Your address draft is kept; temporary screenshot, selection and tool state may need reopening.</span>
      <small>Original page: {tab.url}</small>
      <button className="small-button" type="button" onClick={retry}>Retry Browser view</button>
      <button className="small-button" type="button" disabled={tab.url === 'about:blank'} onClick={() => {
        void api.ui.openExternal(tab.url).catch(error => setActionError(`External open failed: ${presentError(error)}`))
      }}>Open original page externally</button>
      <button className="small-button" type="button" onClick={() => useAppStore.getState().setMainSurface('workbench')}>Return to Space</button>
      {actionError ? <span role="alert">{actionError}</span> : null}
    </div>
  </section>
}
