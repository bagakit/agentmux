import type { NodeIdentity } from '@agentmux/core/node-publishing'
import { formatHostAddress } from '@agentmux/core/sharing'
import { ContentCopyButton } from '@agentmux/client-ui/components/ContentCopyButton'
import './node-share-address.css'

/** Receives an observed publication identity, never an editable alias or Host label. */
export function NodeShareAddress({ node }: { node: Pick<NodeIdentity, 'alias' | 'runtimeId'> }) {
  if (!node.alias) return null
  const address = formatHostAddress({ alias: node.alias, runtimeId: node.runtimeId })
  return <div className="node-share-address">
    <div><span>Published Node address</span><code>{address}</code></div>
    <ContentCopyButton text={address} identity={address} label="Copy Node address" />
  </div>
}
