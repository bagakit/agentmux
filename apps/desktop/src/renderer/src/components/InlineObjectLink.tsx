import { useState } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { ObjectLinkReference } from '@agentmux/client-ui'
import { api } from '../lib/api'
import { copyTextToClipboard } from '../lib/clipboard-copy'
import { useAppStore } from '../store'
import { InlineAgentLink } from './InlineAgentLink'

const ThemeActionFocusIcon = semanticIconComponent('action.focus')
const ThemeLayoutDockIcon = semanticIconComponent('layout.dock')
const ThemeObjectTabsIcon = semanticIconComponent('object.tabs')
const ThemeLayoutScaleIcon = semanticIconComponent('layout.scale')
const ThemeStatusCopiedIcon = semanticIconComponent('status.copied')
const ThemeActionCopyIcon = semanticIconComponent('action.copy')


/** Core owns the identity; the host only presents its kind and routes the unchanged URI. */
export function InlineObjectLink({ uri, target, label }: ObjectLinkReference) {
  const [copiedUri, setCopiedUri] = useState<string | null>(null)
  const copied = copiedUri === uri
  if (target.kind === 'agent') return <InlineAgentLink uri={uri} agentSessionId={target.agentSessionId} {...(label ? {label} : {})} />
  const kind = target.kind === 'region' ? 'Region' : target.kind === 'tab' ? 'Tab' : target.kind === 'space' ? 'Space' : 'Zone'
  const id = target.kind === 'region' ? target.regionId : target.kind === 'tab' ? target.tabId : target.kind === 'space' ? target.spaceId : target.zoneId
  const Icon = target.kind === 'region' ? ThemeActionFocusIcon : target.kind === 'tab' ? ThemeLayoutDockIcon : target.kind === 'space' ? ThemeObjectTabsIcon : ThemeLayoutScaleIcon
  return <span className="inline-object-link" data-object-link={uri}>
    <button type="button" className="inline-object-link__open" data-object-link-open={target.kind}
      title={`${kind}: ${id}\n${uri}`} onClick={() => { void api.ui.openObjectLink(uri).catch(useAppStore.getState().reportError) }}>
      <Icon size={14} strokeWidth={1.7} aria-hidden="true" />
      <span className="inline-object-link__label">{label ?? <><span className="inline-object-link__kind">{kind}</span><span className="inline-object-link__id">{id}</span></>}</span>
    </button>
    <button type="button" className="inline-object-link__copy" aria-label={copied ? `${kind} link copied` : `Copy ${kind} link`}
      title={copied ? 'Link copied' : `Copy ${kind} link`} onClick={() => {
        void copyTextToClipboard(uri, useAppStore.getState().reportError).then(ok => { if (ok) setCopiedUri(uri) })
      }}>{copied ? <ThemeStatusCopiedIcon size={12} strokeWidth={1.8} /> : <ThemeActionCopyIcon size={12} strokeWidth={1.6} />}</button>
  </span>
}
