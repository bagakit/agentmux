import { spawn } from 'node:child_process'

/** The compiled CLI owns its real subscription; cancellation closes only this reader. */
export function cliFollow(node: string, cli: string, endpoint: string, env: NodeJS.ProcessEnv, operationId: string, receipt: any) {
  const state: any = { operationId, frames: [], closed: false, code: null, stderr: '' }
  ;(receipt.completeCliFollowers ??= []).push(state)
  const child = spawn(node, [cli, '--endpoint', endpoint, 'browser', 'follow', '--operation-id', operationId, '--after-sequence', '0'],
    { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let pending = ''
  child.stdout.on('data', bytes => {
    pending += bytes.toString()
    for (;;) {
      const index = pending.indexOf('\n'); if (index < 0) break
      const line = pending.slice(0, index); pending = pending.slice(index + 1)
      if (line.trim()) { try { state.frames.push(JSON.parse(line)) } catch { state.parseFailure = true } }
    }
  })
  child.stderr.on('data', bytes => { state.stderr += bytes.toString() })
  const ended = new Promise<void>(resolve => {
    child.once('error', error => { state.error = error.message; state.closed = true; resolve() })
    child.once('close', code => { state.code = code; state.closed = true; resolve() })
  })
  return { state, async dispose() { if (!state.closed) child.kill('SIGTERM'); await ended } }
}
