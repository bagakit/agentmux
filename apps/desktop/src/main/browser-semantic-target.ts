import type { BrowserReplayTarget } from '../shared/browser-operation.js'
import type { BrowserCdpSender, BrowserPageCapture } from './browser-page-snapshot.js'

/** The caller proves its actual main-document DOM handle and owns the existing CDP session. */
export async function verifyBrowserSemanticTarget(input: {
  send: BrowserCdpSender
  objectId: string
  getSnapshot: () => Promise<BrowserPageCapture>
  isCurrent: () => boolean
}): Promise<BrowserReplayTarget | undefined> {
  if (!input.isCurrent()) return undefined
  const described = await input.send('DOM.describeNode', { objectId: input.objectId }) as { node?: { backendNodeId?: number } }
  const backendNodeId = described.node?.backendNodeId
  if (!backendNodeId || !input.isCurrent()) return undefined
  const partial = await input.send('Accessibility.getPartialAXTree', { backendNodeId, fetchRelatives: false }) as { nodes?: { backendDOMNodeId?: number; ignored?: boolean; role?: { value?: string }; name?: { value?: string } }[] }
  const actual = partial.nodes?.find(node => node.backendDOMNodeId === backendNodeId && !node.ignored)
  // Exact selected/event node. Neither CSS nor an ancestor is substituted for an unknown target.
  if (!actual?.role?.value || !actual.name?.value?.trim()) return undefined
  const full = await input.getSnapshot()
  if (!input.isCurrent()) return undefined
  const node = full.nodes.find(candidate => candidate.backendNodeId === backendNodeId && !candidate.sessionId)
  if (!node || !node.ref || !node.name) return undefined
  const matches = full.nodes.filter(candidate => candidate.role === node.role && candidate.name === node.name && !candidate.sessionId)
  if (matches.length !== 1 || matches[0]?.backendNodeId !== backendNodeId) return undefined
  return { role: node.role, name: node.name, ordinal: 1, count: 1 }
}
