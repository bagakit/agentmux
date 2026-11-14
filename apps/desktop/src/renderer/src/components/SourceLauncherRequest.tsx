import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import type { AgentMuxRpcResult } from '@agentmux/core'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { MountedAgentOpenInput } from '../lib/space-mount-launch'
import { openSourceLauncherWork } from '../lib/source-launcher-request'
import { OriginalLaunchNames } from './OriginalLaunchNames'

/** Historical request receipts and fresh original-owner reads remain separate. */
export function SourceLauncherRequest({ input, busy, onContinue, active = true }: { input: MountedAgentOpenInput; busy: boolean; active?: boolean; onContinue(input: MountedAgentOpenInput): void }) {
  const [inspection, setInspection] = useState<AgentMuxRpcResult<'space.inspect'>>(), [issue, setIssue] = useState<string>()
  const reader = useRef<AbortController | undefined>(undefined)
  useEffect(() => () => reader.current?.abort(), [input.request])
  async function check() {
    reader.current?.abort(); const controller = new AbortController(); reader.current = controller
    try {
      const reply = await api.spaceMounts.call('inspect', { hostId: input.target.hostId, reference: input.target.reference, requestId: input.request.operationId }, controller.signal)
      if (!controller.signal.aborted) { setInspection(reply); setIssue(undefined) }
    } catch (cause) { if (!controller.signal.aborted) setIssue(presentError(cause)) }
  }
  const observed = inspection?.request?.known && inspection.request.report?.operationId === input.request.operationId ? inspection.request.report : undefined
  const report = observed ?? input.receipt, terminal = report?.outcome === 'opened' || report?.outcome === 'retired'
  return <div className="launcher-source-original">
    <p role="status">{report?.outcome === 'retired' ? 'The original Agent was retired. Its request and your input are retained.' : report?.outcome === 'opened'
      ? 'The project device confirmed this Agent. Your Launcher draft remains here.' : input.issue ?? 'This original task is retained. Check its project device.'}</p>
    <div className="agent-work-setup__actions"><div>
      <button type="button" className="small-button" onClick={() => void check()}>Check original task</button>
      {!terminal ? <button type="button" className="small-button" disabled={busy} onClick={() => onContinue(input)}>{input.submitted ? 'Continue original task' : 'Send original task'}</button> : null}
      {report?.to ? <button type="button" className="small-button" onClick={() => void openSourceLauncherWork(input, report).catch(cause => setIssue(presentError(cause)))}>Open original work</button> : null}
    </div></div>
    {issue ? <p className="agent-work-setup__error" role="status">{issue}</p> : null}
    <OriginalLaunchNames owner={{ kind: 'source', input, ...(observed ? { observation: observed } : {}) }} active={active} />
    <details><summary>Original request</summary><p>Continuing uses this same operation and frozen target. Checking does not replay its first input.</p><pre>{JSON.stringify({ request: input.request,
      receipt: input.receipt, names: input.origin?.names, ...(input.issue ? { historicalIssue: input.issue } : {}), inspection }, null, 2)}</pre></details>
  </div>
}
