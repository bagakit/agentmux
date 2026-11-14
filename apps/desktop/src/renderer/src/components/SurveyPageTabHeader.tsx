import type { ReactNode } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { BrowserWorkbenchSurface } from '../lib/workbench-tabs'
import { WorkbenchTabMarks } from './WorkbenchTabMarks'
import { WorkbenchTabStrip } from './WorkbenchTabStrip'

const CloseIcon = semanticIconComponent('action.close')
const CreateIcon = semanticIconComponent('action.create-tab')

/** One exact page's chrome; its Region and close/create effects stay with their owners. */
export function SurveyPageTabHeader({ tabId, browser, visible, leadingChrome, creating, onClose, onCreate }: {
  tabId: string
  browser: Pick<BrowserWorkbenchSurface, 'regionId' | 'title' | 'url' | 'driving'>
  visible: boolean
  leadingChrome?: ReactNode
  creating: boolean
  onClose(): void
  onCreate(): void
}) {
  const title = browser.title || (browser.url === 'about:blank' ? 'New Tab' : browser.url)
  return <header className="pane-tabbar pane-tabbar--root pane-group--root survey-page-tab-header">
    {leadingChrome}
    <WorkbenchTabStrip activeTabId={tabId} visible={visible} tabIds={[tabId]}>
      <div className="workbench-tab workbench-tab--active" data-workbench-tab-id={tabId}
        data-survey-current-page={browser.regionId} role="group" aria-label={title} aria-current="page" title={title}>
        <WorkbenchTabMarks marks={[{ kind: 'browser', regionId: browser.regionId, driving: browser.driving }]} />
        <span className="workbench-tab__label">{title}</span>
        <button type="button" className="pane-action workbench-tab__close" aria-label={`Close page: ${title}`}
          title={`Close ${title}`} onClick={onClose}><CloseIcon size={11} /></button>
      </div>
    </WorkbenchTabStrip>
    <div className="pane-tabbar__actions">
      <button type="button" className="pane-action" aria-label="New webpage" title="New webpage"
        disabled={creating} onClick={onCreate}><CreateIcon size={13} /></button>
    </div>
  </header>
}
