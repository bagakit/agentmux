import { displayLabel, displayLabelDocument, nameTargetKey, setDisplayLabelDocument } from '../../../../../packages/core/src/display-label.ts'

/** Only the private name transport is controlled. Focus, Store and revision projection run normally. */
export function prepareInlineRename({ api, useAppStore }) {
  const originalRead = api.spatial.read.bind(api.spatial)
  const originalCommit = api.spatial.commit.bind(api.spatial)
  const target = { kind: 'agent-session', id: 'working' }
  const requests = []
  const confirms = []
  let readCount = 0
  let pending
  let pendingDurability

  api.spatial.read = async () => {
    readCount++
    return originalRead()
  }

  async function settleName(input, confirmed) {
    const state = await originalRead()
    const old = displayLabel(state.graph, target)
    const document = displayLabelDocument(state.graph)
    const applied = input.expectedNameRevision === (old?.nameRevision ?? 0)
    const reason = applied ? null : 'Name changed since this request. Review the current name.'
    const nameRevision = applied ? input.expectedNameRevision + 1 : old?.nameRevision ?? 0
    const record = {
      operationId: input.operationId, id: input.operationId, target,
      before: old?.value ?? null, requested: input.value, actual: applied ? input.value : old?.value ?? null,
      context: { actor: { kind: 'user', id: 'private-electron-review', verified: true }, source: 'manual',
        entryPoint: 'spatial:renameLabel', transport: 'electron-ipc', location: {} },
      status: applied ? 'applied' : 'failed', ownerRevision: nameRevision, reason,
      startedAt: Date.now(), settledAt: Date.now()
    }
    document.records.push(record)
    if (applied) document.labels[nameTargetKey(target)] = { target, nameRevision, source: 'manual', operationId: input.operationId, value: input.value }
    setDisplayLabelDocument(state.graph, document)
    const saved = await originalCommit({ expectedRevision: state.revision, graph: state.graph })
    const diskDurability = confirmed ? 'confirmed' : 'unconfirmed'
    const issue = confirmed ? null : 'The original name was applied. Its disk confirmation is still unknown.'
    const nameCommit = { operationId: input.operationId, target, applied, diskDurability, issue }
    if (!confirmed) pendingDurability = nameCommit
    return { state: { ...saved, nameCommit }, label: displayLabel(saved.graph, target), record, changed: applied && old?.value !== input.value, applied, diskDurability, issue }
  }

  api.spatial.renameLabel = async input => {
    if (nameTargetKey(input.target) !== nameTargetKey(target)) throw Error('Fixture received a different original name target')
    if (pending) throw Error('Fixture received another write while an original name request is pending')
    requests.push(structuredClone(input))
    const result = await new Promise(resolve => { pending = resolve })
    pending = undefined
    if (result === 'unavailable') throw Error('The original name store did not respond.')
    return settleName(input, result === 'confirmed')
  }

  api.spatial.confirmNameCommit = async operationId => {
    if (operationId !== pendingDurability?.operationId) throw Error('The confirmed receipt must belong to the same original edit')
    confirms.push(operationId)
    const state = await originalRead()
    return { ...state, nameCommit: { ...pendingDurability, diskDurability: 'confirmed', issue: null } }
  }

  const sessionIdentities = state => state.sessions.map(session => ({
    id: session.id, hostId: session.hostId,
    agentSessionId: session.control?.agentSessionId, runId: session.control?.run?.runId,
  })).sort((left, right) => left.id.localeCompare(right.id))
  const originalWorkface = state => {
    const tab = state.tabs['ordinary-tab']
    return tab && {
      id: tab.id, workspaceId: tab.workspaceId, titleRegionId: tab.titleRegionId, layout: tab.layout,
      regions: Object.entries(tab.regions).map(([id, region]) => ({
        id, kind: region.kind, sessionId: region.sessionId, phase: region.phase,
      })),
    }
  }
  window.inlineRenameProof = {
    release(result) {
      if (!pending) throw Error('The original name request has not arrived')
      pending(result)
    },
    async competingName(value) {
      const state = await originalRead()
      const old = displayLabel(state.graph, target)
      await settleName({ operationId: 'private-competitor-' + state.revision, value, expectedNameRevision: old?.nameRevision ?? 0 }, true)
    },
    async facts() {
      const state = useAppStore.getState()
      const owner = await originalRead()
      return {
        name: state.agentNames[target.id] ?? null,
        label: owner ? displayLabel(owner.graph, target) : null,
        requests: structuredClone(requests), confirms: [...confirms], readCount,
        sessions: sessionIdentities(state),
        workface: originalWorkface(state),
        originalDraft: state.agentComposerDrafts.working,
      }
    }
  }
}
