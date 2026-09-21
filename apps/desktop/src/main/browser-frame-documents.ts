import type { BrowserPageFrameFailure } from '../shared/contracts.js'
import type { BrowserCdpSender } from './browser-page-snapshot.js'

/** Per-observation facts, not a second frame/session registry. */
export type BrowserFrameDocument = {
  frameId: string | null
  loaderId: string | null
  depth: number
  sessionId?: string
  sendCommand: BrowserCdpSender
}

type FrameTree = {
  frame: { id: string; parentId?: string; loaderId?: string }
  childFrames?: FrameTree[]
}
type Frame = FrameTree['frame']
export const MAX_BROWSER_FRAME_DOCUMENTS = 128

export type BrowserFrameDocuments = {
  documents: BrowserFrameDocument[]
  missingFrames: BrowserPageFrameFailure[]
  /** Actual sender roots retained only until this observation finishes. */
  roots: { frameId: string; sendCommand: BrowserCdpSender }[]
}

async function readTree(send: BrowserCdpSender): Promise<FrameTree> {
  const response = await send('Page.getFrameTree') as { frameTree?: FrameTree }
  if (!response.frameTree?.frame?.id) throw new Error('Page.getFrameTree returned no document identity')
  return response.frameTree
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Native frame-tree ancestry selects the sender; neither URL nor session ID selects a document. */
export async function discoverBrowserFrameDocuments(
  main: BrowserCdpSender,
  sessions: Map<string, BrowserCdpSender>
): Promise<BrowserFrameDocuments> {
  const facts = new Map<string, Frame>()
  const owners = new Map<string, { sendCommand: BrowserCdpSender; sessionId?: string }>()
  const roots: BrowserFrameDocuments['roots'] = []
  const missingFrames: BrowserPageFrameFailure[] = []
  const unavailable = new Set<string>()
  let mainFrameId: string | null = null
  let budgetReported = false
  const addTree = (tree: FrameTree, owner: { sendCommand: BrowserCdpSender; sessionId?: string }): void => {
    const previousOwner = owners.get(tree.frame.id)
    if (previousOwner && previousOwner.sendCommand !== owner.sendCommand) {
      unavailable.add(tree.frame.id)
      missingFrames.push({ frameId: tree.frame.id, reason: 'More than one CDP session claims this document. Take a new snapshot().' })
    } else {
      owners.set(tree.frame.id, owner)
      roots.push({ frameId: tree.frame.id, sendCommand: owner.sendCommand })
    }
    const pending = [{ tree, parentId: tree.frame.parentId }]
    while (pending.length) {
      const current = pending.pop()!
      const id = current.tree.frame?.id
      if (!id) {
        missingFrames.push({ frameId: tree.frame.id, reason: 'A nested frame has no native document identity. Take a new snapshot().' })
        continue
      }
      if (!facts.has(id) && facts.size >= MAX_BROWSER_FRAME_DOCUMENTS) {
        if (!budgetReported) missingFrames.push({ frameId: id, reason: `The ${MAX_BROWSER_FRAME_DOCUMENTS}-document observation budget was reached; further embedded documents were not observed. Inspect a smaller page or retry after removing frames.` })
        budgetReported = true
        continue
      }
      // A session-root response can omit its parent. Keep the actual ancestry
      // already observed in another native tree; absence is not a new parent.
      const parentId = current.tree.frame.parentId ?? current.parentId ?? facts.get(id)?.parentId
      facts.set(id, { ...current.tree.frame, ...(parentId ? { parentId } : {}) })
      for (const child of [...current.tree.childFrames ?? []].reverse()) pending.push({ tree: child, parentId: id })
    }
  }
  try {
    const tree = await readTree(main)
    mainFrameId = tree.frame.id
    addTree(tree, { sendCommand: main })
  } catch (error) {
    missingFrames.push({ frameId: '(document discovery)', reason: `Embedded document discovery is unavailable (${errorText(error)}). The main accessibility tree can still be read, but embedded coverage is unknown. Retry snapshot().` })
  }
  let attachedRead = 0
  for (const [sessionId, send] of sessions) {
    if (attachedRead++ >= MAX_BROWSER_FRAME_DOCUMENTS) {
      missingFrames.push({ frameId: '(attached document discovery)', reason: `The ${MAX_BROWSER_FRAME_DOCUMENTS}-session discovery budget was reached. Further attached documents were not observed; retry a smaller page.` })
      break
    }
    try { addTree(await readTree(send), { sendCommand: send, sessionId }) }
    catch (error) {
      // The session is known, its frame ID is not. Do not advertise the session as a document ID.
      missingFrames.push({ frameId: '(attached document discovery)', reason: `The document behind CDP session ${sessionId} could not be identified (${errorText(error)}). Retry snapshot().` })
    }
  }
  const documents: BrowserFrameDocument[] = []
  if (!mainFrameId) documents.push({ frameId: null, loaderId: null, depth: 0, sendCommand: main })
  for (const frame of facts.values()) {
    if (unavailable.has(frame.id)) continue
    const ancestors = new Set<string>()
    let cursor: Frame | undefined = frame
    let owner: { sendCommand: BrowserCdpSender; sessionId?: string } | undefined
    let depth = 0
    while (cursor && !ancestors.has(cursor.id)) {
      if (unavailable.has(cursor.id)) { cursor = undefined; break }
      ancestors.add(cursor.id)
      owner ??= owners.get(cursor.id)
      if (!cursor.parentId) break
      cursor = facts.get(cursor.parentId)
      depth += 1
    }
    if (!owner || !cursor || (cursor.parentId !== undefined && ancestors.has(cursor.parentId))) {
      missingFrames.push({ frameId: frame.id, reason: 'The document ancestry/sender could not be established. Take a new snapshot().' })
      continue
    }
    if (mainFrameId && cursor.id !== mainFrameId) {
      missingFrames.push({ frameId: frame.id, reason: 'The document is no longer joined to this Browser frame tree. Take a new snapshot().' })
      continue
    }
    documents.push({ frameId: frame.id, loaderId: frame.loaderId ?? null, depth, ...owner })
  }
  return { documents, missingFrames, roots }
}

/** Check captured document loaders after AX work. A sender remaining alive does not prove its document stayed. */
export async function changedBrowserFrameDocuments(
  discovery: BrowserFrameDocuments
): Promise<Map<string, string>> {
  const current = new Map<string, Frame>()
  const failedRoots = new Map<BrowserCdpSender, string>()
  for (const root of discovery.roots) {
    try {
      const tree = await readTree(root.sendCommand)
      const pending = [tree]
      let read = 0
      while (pending.length && read++ < MAX_BROWSER_FRAME_DOCUMENTS) {
        const node = pending.pop()!
        current.set(node.frame.id, node.frame)
        pending.push(...[...node.childFrames ?? []].reverse())
      }
    } catch (error) { failedRoots.set(root.sendCommand, errorText(error)) }
  }
  const changed = new Map<string, string>()
  for (const document of discovery.documents) {
    if (document.frameId === null) continue
    const frame = current.get(document.frameId)
    const failure = failedRoots.get(document.sendCommand)
    if (failure) changed.set(document.frameId, `Document currency could not be checked (${failure}). Retry snapshot().`)
    else if (!frame || document.loaderId === null || frame.loaderId !== document.loaderId) {
      changed.set(document.frameId, 'The document disappeared, changed, or has no known loader identity during observation. Take a new snapshot().')
    }
  }
  return changed
}
