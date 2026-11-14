import { useEffect, useMemo, useState } from 'react'
import type { AgentOpenDescription } from '@agentmux/core/agent-open-contract'
import type { AgentMuxHostExecutorInventory } from '@agentmux/core/executor-contract'
import { configValuesEqual } from '../../../shared/config-edit'
import type { ExecutorChoice } from '../lib/executors'
import type { LauncherSourceExecution } from '../lib/launcher-source'
import { api } from '../lib/api'
import { presentError } from '@agentmux/client-ui/error-presentation'

/** Visible selected-source reads only. Declarations never imply Native qualification. */
export function useSourceLauncher(selection: LauncherSourceExecution | undefined, active: boolean) {
  const sourceKey = JSON.stringify(selection ? [selection.target.hostId, selection.target.reference.runtimeId] : null)
  const reach = selection?.kind === 'source-coordinator'
  const targetKey = JSON.stringify(reach ? selection.coordinator : selection?.agentTarget)
  const targetScope = JSON.stringify([sourceKey, targetKey])
  const [contractRead, setDescription] = useState<{ key: string; value: AgentOpenDescription }>(), [contractError, setContractIssue] = useState<{ key: string; message: string }>()
  const [inventoryRead, setInventory] = useState<{ key: string; value: AgentMuxHostExecutorInventory }>(), [inventoryError, setInventoryIssue] = useState<{ key: string; message: string }>()
  const [selectedRead, setSelectedInventory] = useState<{ key: string; value: AgentMuxHostExecutorInventory }>(), [selectedError, setSelectedIssue] = useState<{ key: string; message: string }>()
  const description = contractRead && contractRead.key === sourceKey ? contractRead.value : undefined
  const inventory = inventoryRead && inventoryRead.key === targetScope ? inventoryRead.value : undefined
  const [refresh, setRefresh] = useState(0)
  const executorId = selection?.executorId
    ?? inventory?.executors.find(item => item.source !== 'provider-default' && item.availability !== 'missing')?.executorId
    ?? inventory?.executors.find(item => item.availability === 'available')?.executorId
  const selectedScope = JSON.stringify([targetScope, executorId])
  const selectedInventory = selectedRead && selectedRead.key === selectedScope ? selectedRead.value : undefined
  useEffect(() => {
    setDescription(undefined); setContractIssue(undefined)
    if (!active || !selection) return
    const controller = new AbortController(), source = { hostId: selection.target.hostId, expectedRuntimeId: selection.target.reference.runtimeId }
    void api.spaceMounts.call('describe', source, controller.signal).then(value => {
      if (controller.signal.aborted) return
      if (value.sourceIssue) { setContractIssue({ key: sourceKey, message: value.sourceIssue.message }); return }
      setDescription({ key: sourceKey, value })
    })
      .catch(error => { if (!controller.signal.aborted) setContractIssue({ key: sourceKey, message: presentError(error) }) })
    return () => controller.abort()
  }, [active, sourceKey, refresh])
  function read(selected?: string, signal?: AbortSignal) {
    if (!selection) throw Error('Choose the original project and Agent target.')
    const source = { hostId: selection.target.hostId, expectedRuntimeId: selection.target.reference.runtimeId }
    const executor = selected === undefined ? {} : { executorId: selected }
    if (selection.kind === 'source-coordinator') return api.spaceMounts.call('executors', {
      hostId: selection.coordinator.hostId, expectedRuntimeId: selection.coordinator.runtimeId, agentHostId: 'local', ...executor }, signal)
    return selection.agentTarget.adoptedRoute
      ? api.spaceMounts.call('routeExecutors', { ...source, agentTarget: { ...selection.agentTarget, adoptedRoute: selection.agentTarget.adoptedRoute }, ...executor }, signal).then(reply => {
        if (!configValuesEqual(reply.agentTarget, selection.agentTarget)) throw Error('The original execution route changed. Your selection and draft are retained.')
        return reply.inventory
      })
      : api.spaceMounts.call('executors', { ...source, agentHostId: selection.agentTarget.hostId, ...executor }, signal)
  }
  useEffect(() => {
    setInventory(undefined); setInventoryIssue(undefined)
    if (!active || !selection) return
    const controller = new AbortController()
    void read(undefined, controller.signal).then(value => {
      if (value.runtimeId !== (selection.kind === 'source-coordinator' ? selection.coordinator.runtimeId : selection.agentTarget.runtimeId)) throw Error('The original Agent Runtime changed. Your draft and saved target are retained.')
      if (!controller.signal.aborted) setInventory({ key: targetScope, value })
    }).catch(error => { if (!controller.signal.aborted) setInventoryIssue({ key: targetScope, message: presentError(error) }) })
    return () => controller.abort()
  }, [active, sourceKey, targetKey, refresh])
  useEffect(() => {
    setSelectedInventory(undefined); setSelectedIssue(undefined)
    if (!active || !selection || !executorId) return
    const controller = new AbortController()
    void read(executorId, controller.signal).then(value => {
      if (value.runtimeId !== (selection.kind === 'source-coordinator' ? selection.coordinator.runtimeId : selection.agentTarget.runtimeId)) throw Error('The selected declaration belongs to another Agent Runtime. The original input is retained.')
      if (!controller.signal.aborted) setSelectedInventory({ key: selectedScope, value })
    }).catch(error => { if (!controller.signal.aborted) setSelectedIssue({ key: selectedScope, message: presentError(error) }) })
    return () => controller.abort()
  }, [active, sourceKey, targetKey, executorId, refresh])
  const selected = selectedInventory?.executors.find(item => item.executorId === executorId)
  const executors = useMemo<ExecutorChoice[]>(() => {
    const entries = inventory?.executors ?? []
    // The exact selected read owns its Provider/revision even while the optional
    // catalogue is pending or still shows an earlier registration observation.
    const current = selected ? [selected, ...entries.filter(item => item.executorId !== selected.executorId)] : entries
    return current.map(item => ({ id: item.executorId, label: item.label, command: item.command, providerId: item.providerId, executorRevision: item.configRevision,
      source: item.source, detection: {
        state: item.availability === 'available' ? 'ready' : item.availability === 'missing' ? 'missing' : item.availability === 'check-failed' ? 'error' : 'idle',
        ...(item.cause ? { cause: item.cause, detail: `${item.cause.code}: ${item.cause.message}` } : {}),
      } }))
  }, [inventory, selected])
  return { executors, executorId, selected, description, issue: (contractError && contractError.key === sourceKey ? contractError.message : undefined) ?? (selectedError && selectedError.key === selectedScope ? selectedError.message : undefined) ?? (inventoryError && inventoryError.key === targetScope ? inventoryError.message : undefined),
    ready: !!selected && (reach ? description?.contracts.externalAssociation !== null : description?.contracts.ordinaryLaunch !== null) && selected.creationContract?.ordinaryLaunch === 1,
    refresh: () => setRefresh(value => value + 1) }
}
