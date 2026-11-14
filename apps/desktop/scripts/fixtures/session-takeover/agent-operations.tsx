import React, { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { createFocusProjectionSelector } from '../../../src/renderer/src/lib/focus-context'
import { FocusContextRow } from '../../../src/renderer/src/components/FocusContextRow'
import type { RuntimeEvent, SessionSnapshot } from '../../../src/shared/contracts'
import { createOperationOutputStream } from './operation-output-stream.mjs'

/** Controlled Native facts only. No fixture writes a client operation phase or request. */
export function configureOperationSources(snapshot: any, creations: Record<string, any>, restored: boolean, originalIds?: string[]) {
  if (!restored) {
    const sample = snapshot.sessions.find((session: SessionSnapshot) => session.kind === 'agent')
    if (!sample) throw new Error('Agent operations need nonempty original Native sources')
    snapshot.sessions = [0, 1, 2].map(index => {
      const retained = snapshot.sessions[index] ?? { ...sample, id: `operation-private-source-${index}`,
        control: { ...sample.control, agentSessionId: `operation-private-source-${index}`, run: { runId: `operation-private-run-${index}` } } }
      return { ...retained, executorId: 'codex', providerId: 'codex', processState: 'running',
        nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: `controlled-native-${retained.id}`, transcriptPath: `/private-fixture/${retained.id}.jsonl` },
        capabilities: { ...retained.capabilities, providerFork: { current: true } },
        status: { state: 'working', source: 'native-hook', observedAt: Date.now(), detail: 'Controlled Native source remains available.' } }
    })
  }
  for (const source of snapshot.sessions.filter((item: SessionSnapshot) => !originalIds || originalIds.includes(item.id)).slice(0, 3)) {
    if (source.kind !== 'agent' || !source.nativeHandle || !source.capabilities.providerFork?.current) throw new Error('Exact controlled Native fork source is incomplete')
    creations[source.id] ??= { ...source, kind: 'agent', agentSessionId: source.id, run: source.control.run,
      creation: { createOperationId: `original-fixture:${source.id}`, initialPrompt: 'confirmed' }, launchOptions: {} }
  }
}

export function installOperationFixture({ snapshot, creations, boot, saveRuntime, terminalFacts }: any) {
  const originals: string[] = boot?.operationFixture?.originals ?? snapshot.sessions.slice(0, 3).map((session: SessionSnapshot) => session.id)
  const sourceSessions: SessionSnapshot[] = snapshot.sessions.filter((session: SessionSnapshot) => originals.includes(session.id))
  const controls = { creation: 'hold', stop: 'hold' } as { creation: 'hold' | 'success' | 'lost'; stop: 'hold' | 'success' | 'lost' }
  const partialCreation = new Set<string>()
  const pending = new Map<string, { kind: string; resolve(value: unknown): void; reject(error: Error): void }>()
  const calls: any[] = [], output: Record<string, string> = { ...(boot?.operationFixture?.output ?? {}) }
  const stops: Record<string, any> = { ...(boot?.operationFixture?.stops ?? {}) }
  const counters = { projection: 0, cardMutations: 0, streamLines: 0 }
  const inputs: any[] = [], subscribers = new Map<(event: RuntimeEvent) => void, any>()
  let cardsVisible = true
  const outputStream = createOperationOutputStream((bounded: boolean) =>
    line(`Controlled live output ${bounded ? String(counters.streamLines).padStart(10, '0') : counters.streamLines}\r\n`))
  const baseEvents = api.sessions.onEvent, baseWrite = api.sessions.write, baseAttach = api.sessions.attach
  api.sessions.onEvent = (listener, control) => {
    subscribers.set(listener, control)
    const release = baseEvents(listener, control)
    return () => { subscribers.delete(listener); release() }
  }
  function emit(event: RuntimeEvent) {
    for (const [listener, control] of subscribers) if (!control || control.hostId === event.hostId && control.run.runId === ('run' in event.event ? event.event.run?.runId : undefined)) listener(event)
  }
  api.sessions.write = async (...args) => {
    inputs.push({ control: structuredClone(args[0]), data: typeof args[1] === 'string' ? args[1] : Array.from(args[1]), observedAt: performance.now() })
    return baseWrite(...args)
  }
  api.sessions.attach = async (control, afterByte = 0) => {
    const result = await baseAttach(control, afterByte)
    if (control.kind !== 'agent' || !originals.includes(control.agentSessionId)) return result
    const id = control.agentSessionId
    output[id] ??= result.replay.map(frame => frame.type === 'data' ? frame.data : '').join('')
    const allBytes = new TextEncoder().encode(output[id]), bytes = allBytes.slice(afterByte)
    const session = snapshot.sessions.find((item: SessionSnapshot) => item.id === id)
    session.latestOutputBytes = allBytes.length
    return { ...result, session: structuredClone(session), replay: bytes.length ? [{ type: 'data' as const, runId: control.run.runId,
      startByte: afterByte, endByte: allBytes.length, data: new TextDecoder().decode(bytes), dataBytes: bytes }] : [] }
  }
  function line(data: string) {
    const source = snapshot.sessions.find((session: SessionSnapshot) => session.id === originals[0])
    if (!source || output[source.id] === undefined) return
    const startByte = new TextEncoder().encode(output[source.id]).length, dataBytes = new TextEncoder().encode(data)
    output[source.id] += data; source.latestOutputBytes = startByte + dataBytes.length
    emit({ type: 'core', hostId: source.hostId, event: { type: 'terminal-output', agentSessionId: source.id,
      run: source.control.run, data, dataBytes, evidence: { source: 'terminal-output', observedAt: Date.now(), run: source.control.run,
        outputByteRange: { startByte, endByte: source.latestOutputBytes } } } })
    counters.streamLines++
  }
  api.sessions.stop = async (control, operationId) => {
    if (control.kind !== 'agent' || !operationId) throw new Error('Controlled Stop requires exact Agent and operation')
    const source = snapshot.sessions.find((session: SessionSnapshot) => session.id === control.agentSessionId && session.control.run.runId === control.run.runId && session.hostId === control.hostId)
    if (!source) throw new Error('Controlled Native Stop refuses a changed Host, Session or Run')
    calls.push({ kind: 'stop', operationId, control: structuredClone(control) })
    stops[operationId] ??= { control: structuredClone(control), phase: 'stopping' }
    await saveRuntime()
    return new Promise((resolve, reject) => pending.set(operationId, { kind: 'stop', resolve, reject })) as any
  }
  api.sessions.inspectStop = async (control, operationId) => {
    calls.push({ kind: 'stop-inspect', operationId, control: structuredClone(control) })
    const held = stops[operationId], matches = held?.control.hostId === control.hostId && held.control.agentSessionId === control.agentSessionId && held.control.run.runId === control.run.runId
    return { agentSessionId: control.agentSessionId, expectedRun: control.run, phase: matches ? held.phase : 'unconfirmed',
      operationIdMatched: Boolean(matches), canRetry: Boolean(matches && held.phase === 'stopping'), observedAt: Date.now(),
      ...(held?.failure ? { failure: held.failure } : {}) }
  }
  const baseLaunch = api.sessions.launchAgent
  api.sessions.launchAgent = async input => {
    calls.push({ kind: 'creation', operationId: input.createOperationId, fork: Boolean(input.forkSource), source: input.forkSource, target: input.agentSessionId })
    if (controls.creation === 'hold') await new Promise<void>((resolve, reject) => pending.set(input.createOperationId!, { kind: 'creation', resolve: () => resolve(), reject }))
    const launched = await baseLaunch(input)
    if (partialCreation.delete(input.createOperationId!)) {
      launched.created.creation!.initialPrompt = 'unconfirmed'
      creations[launched.created.agentSessionId] = launched.created
      await saveRuntime()
    }
    if (controls.creation === 'lost') throw new Error('Controlled Native first receipt lost after creation; inspect the same original request.')
    return launched
  }
  const element = document.getElementById('root')!
  function OperationCards() {
    const selector = useMemo(createFocusProjectionSelector, [])
    const contexts = useAppStore(useShallow(state => {
      counters.projection++
      return selector(state, true, 'metadata').contexts.filter(context => originals.includes(context.id))
    }))
    return <aside ref={node => { if (node) { const observer = new MutationObserver(records => { counters.cardMutations += records.length }); observer.observe(node, { childList: true, subtree: true, characterData: true }); return () => observer.disconnect() } }} id="agent-operation-cards" aria-label="Actual Focus Agent cards" style={{ overflowY: 'auto', minWidth: 0, padding: 12 }}>
      {contexts.map(context => <React.Fragment key={context.id}>
        <FocusContextRow context={context} selected={false} onSelect={id => {
          const state = useAppStore.getState(), tab = Object.values(state.tabs).find(tab => Object.values(tab.regions).some(region => region.kind === 'agent' && region.sessionId === id))
          const group = tab && state.layouts[tab.workspaceId]?.groups.find(group => group.tabOrder.includes(tab.id))
          if (tab && group) state.activateTab(tab.workspaceId, group.id, tab.id)
        }} />
      </React.Fragment>)}
    </aside>
  }
  async function resolveOperation(operationId: string, result: 'success' | 'lost' | 'partial') {
    const held = pending.get(operationId)
    if (!held) throw new Error('No exact controlled Native pending operation: ' + operationId)
    pending.delete(operationId)
    calls.push({ kind: 'resolve', operationId, result })
    if (held.kind === 'creation') {
      controls.creation = result === 'lost' ? 'lost' : 'success'
      if (result === 'partial') partialCreation.add(operationId)
      held.resolve(null)
    } else {
      const stop = stops[operationId]
      if (result === 'success') {
        stop.phase = 'retired'
        const source = snapshot.sessions.find((session: SessionSnapshot) => session.id === stop.control.agentSessionId)
        if (!source) throw new Error('Controlled Stop lost its exact original source')
        creations[source.id] = { kind: 'retired-agent', agentSessionId: source.id, hostId: source.hostId, run: source.control.run, source: 'user', observedAt: Date.now(), history: { providerId: source.providerId, executorId: source.executorId, workspacePath: source.workspacePath, createdAt: source.createdAt } }
        snapshot.sessions = snapshot.sessions.filter((session: SessionSnapshot) => session.id !== source.id)
        emit({ type: 'core', hostId: source.hostId, event: { type: 'run-removed', agentSessionId: source.id, run: source.control.run, evidence: { source: 'user', observedAt: Date.now(), run: source.control.run } } })
        held.resolve({ agentSessionId: stop.control.agentSessionId, expectedRun: stop.control.run, operationId,
          lifecycleOperationId: `private-stop:${operationId}`, admission: 'new', retiredAt: Date.now(), runtime: { observed: 'running', stop: 'graceful' }, stages: [] })
      } else {
        stop.failure = { stage: 'runtime-stop', code: 'CONTROLLED_STOP_RECEIPT_LOST', message: 'Original Stop receipt is unconfirmed.', observedAt: Date.now() }
        held.reject(Object.assign(new Error(stop.failure.message), { code: stop.failure.code, stage: 'runtime-stop' }))
      }
    }
    await saveRuntime()
  }
  function unrelated(count: number) {
    const state = useAppStore.getState(), base = sourceSessions[0]!
    const retained = Array.from({ length: count }, (_, index) => ({ ...base, id: `unrelated-retained-${index}`, workspacePath: `/private-unrelated/${index}`,
      control: { ...base.control, agentSessionId: `unrelated-retained-${index}`, run: { runId: `unrelated-retained-run-${index}` } } })) as SessionSnapshot[]
    useAppStore.setState({ sessions: [...state.sessions.filter(session => !session.id.startsWith('unrelated-retained-')), ...retained] })
    return retained.length
  }
  return {
    OperationCards,
    state: () => ({ originals, output, stops }),
    async save() { await saveRuntime() },
    facts: () => ({ originals, pending: [...pending].map(([operationId, entry]) => ({ operationId, kind: entry.kind })), calls: [...calls],
      operations: useAppStore.getState().agentOperations, counters: { ...counters }, inputs: [...inputs], outputBytes: Object.fromEntries(Object.entries(output).map(([id, data]) => [id, new TextEncoder().encode(data).length])),
      cardsVisible, streaming: outputStream.running, sourceControls: sourceSessions.map(session => session.control), terminal: terminalFacts() }),
    creation(mode: typeof controls.creation) { controls.creation = mode },
    resolve: resolveOperation, unrelated,
    showCards(value: boolean) { cardsVisible = value; const pane = element.querySelector<HTMLElement>('#agent-operation-cards'); if (pane) pane.hidden = !value },
    offscreen(value: boolean) { const pane = element.querySelector<HTMLElement>('#agent-operation-cards'); if (pane) pane.style.transform = value ? 'translateY(200vh)' : '' },
    scrollCards(value: number) { const pane = element.querySelector<HTMLElement>('#agent-operation-cards'); if (pane) pane.scrollTop = value },
    stream(value: boolean, count?: number) {
      outputStream.stop()
      if (value) { if (counters.streamLines === 0) line(Array.from({ length: 180 }, (_, index) => `Controlled ordered terminal history ${index}\r\n`).join(''))
        outputStream.start(count) }
    }
  }
}
