import { mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AgentMuxDesktopFocusServer,
  requestAgentMuxDesktopFocus
} from '../src/desktop-focus-control.js'
import { AgentMuxError } from '../src/errors.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

describe('external Desktop focus bridge', () => {
  it('forwards one typed target and preserves fail-closed resolver errors', async () => {
    const root = await mkdtemp('/private/tmp/agentmux-focus-control-')
    roots.push(root)
    const path = join(root, 'focus.sock')
    const seen: unknown[] = []
    const server = new AgentMuxDesktopFocusServer({
      async focus(target) {
        seen.push(target)
        if (target.kind === 'agent-session') {
          throw new AgentMuxError('View target is not currently open.', 'VIEW_NOT_OPEN')
        }
        return { viewId: target.viewId, kind: 'terminal' }
      }
    }, path)
    await server.start()
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    await expect(requestAgentMuxDesktopFocus({
      kind: 'terminal-view', viewId: 'terminal-view-1'
    }, path)).resolves.toEqual({ viewId: 'terminal-view-1', kind: 'terminal' })
    await expect(requestAgentMuxDesktopFocus({
      kind: 'agent-session', agentSessionId: 'closed-agent'
    }, path)).rejects.toMatchObject({ code: 'VIEW_NOT_OPEN' })
    expect(seen).toEqual([
      { kind: 'terminal-view', viewId: 'terminal-view-1' },
      { kind: 'agent-session', agentSessionId: 'closed-agent' }
    ])
    await server.stop()
    await expect(requestAgentMuxDesktopFocus({
      kind: 'terminal-view', viewId: 'terminal-view-1'
    }, path)).rejects.toMatchObject({ code: 'DESKTOP_FOCUS_UNAVAILABLE' })
  })
})
