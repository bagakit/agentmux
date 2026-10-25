import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const describeError = error => ({ name: error?.name ?? 'Error', message: String(error?.message ?? error),
  ...(typeof error?.code === 'string' ? { code: error.code } : {}) })
const ownerRef = owner => ({ owner: owner.name, ownerRoot: owner.base })

/** This fixture owns only explicitly registered proof resources, never discovered PIDs. */
export function createExecutionProofCleanup(root, { timeoutMs = 10000 } = {}) {
  const report = { schema: 'agentmux.execution-proof-cleanup.v1', root, passed: false, records: [], errors: [] }
  const children = []
  const within = async operation => {
    let timer
    try { return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Test-owned cleanup outcome is unconfirmed after its observation deadline')), timeoutMs)
    })]) } finally { clearTimeout(timer) }
  }
  const step = async (target, operation) => {
    const receipt = { kind: 'operation', ...target, state: 'unknown' }; report.records.push(receipt)
    try { const value = await within(operation); receipt.state = 'completed'; return value }
    catch (error) { receipt.error = describeError(error); report.errors.push({ ...target, error: receipt.error }) }
  }
  return {
    report,
    step,
    trackChild(owner, lane, child) {
      if (children.some(value => value.child === child)) return child
      const receipt = { kind: 'child', ...ownerRef(owner), lane, childPid: child.pid ?? null, closed: false, exitCode: null, signal: null, errors: [] }
      report.records.push(receipt)
      let done
      const closed = new Promise(resolve => { done = resolve })
      // Register at spawn, before exit/close can be lost or owner.core is replaced.
      child.on('error', error => { receipt.errors.push(describeError(error)) })
      child.once('close', (code, signal) => { Object.assign(receipt, { closed: true, exitCode: code, signal }); done() })
      children.push({ child, closed, receipt })
      return child
    },
    async finish(owners, { failed = false, error: primaryError } = {}) {
      if (failed) report.primaryFailure = describeError(primaryError)
      for (const owner of owners) {
        const target = ownerRef(owner)
        // A resumed Session supersedes its own earlier Run; never stop a stale ref.
        const sessions = new Map(owner.sessions.map(session => [session.agentSessionId, session]))
        for (const session of sessions.values()) await step({ ...target, action: 'stop-agent', agentSessionId: session.agentSessionId, run: session.run },
          () => owner.client.stopAgent(session.agentSessionId, session.run))
        for (const runId of new Set(owner.runs)) await step({ ...target, action: 'stop-terminal', run: { runId } }, () => owner.client.stopTerminal({ runId }))
        if (owner.client) await step({ ...target, action: 'dispose-client' }, () => owner.client.dispose())
        if (owner.rpc) await step({ ...target, action: 'dispose-rpc' }, () => owner.rpc.dispose())
      }
      for (const { child, closed, receipt } of [...children].sort((a, b) => Number(a.receipt.lane === 'native') - Number(b.receipt.lane === 'native'))) await step({ owner: receipt.owner, ownerRoot: receipt.ownerRoot, action: 'close-child', lane: receipt.lane, childPid: receipt.childPid }, async () => {
        if (!receipt.closed && child.exitCode === null && child.signalCode === null) {
          receipt.signalRequested = 'SIGTERM'
          if (!child.kill('SIGTERM')) throw new Error('The exact test-owned child did not accept SIGTERM; exit is unconfirmed')
        }
        await closed // exit alone does not prove that inherited stdio has closed.
        if (receipt.errors.length) throw new AggregateError(receipt.errors, 'The test-owned child reported process errors')
      })
      report.passed = report.errors.length === 0 && children.every(({ receipt }) => receipt.closed)
      try { await writeFile(join(root, 'cleanup.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }) }
      catch (error) { report.passed = false; report.errors.push({ action: 'write-cleanup-receipt', error: describeError(error) }); console.error('Cleanup receipt could not be saved:', String(error)) }
      if (failed) throw primaryError
      if (!report.passed) throw new AggregateError(report.errors, 'Test-owned cleanup is unconfirmed; see ' + join(root, 'cleanup.json'))
      return report
    },
  }
}
