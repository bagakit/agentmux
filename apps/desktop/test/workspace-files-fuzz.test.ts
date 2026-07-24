import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ExecutionHost } from '@agentmux/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceFiles } from '../src/main/workspace-files.js'
import type { WorkspaceRecord } from '../src/shared/contracts.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

describe('deterministic Workspace path fuzz', () => {
  it('seed traversal-64 never reads or creates outside the selected local root', async () => {
    const fixture = await mkdtemp('/private/tmp/agentmux-workspace-fuzz-')
    roots.push(fixture)
    const root = join(fixture, 'workspace')
    const outside = join(fixture, 'outside')
    await mkdir(root)
    await mkdir(outside)
    await writeFile(join(outside, 'secret.txt'), 'secret')
    const host: ExecutionHost = {
      id: 'local',
      kind: 'local',
      label: 'Local',
      run: vi.fn(),
      exposeLoopbackPort: async (port) => port,
      dispose: async () => {}
    }
    const workspace: WorkspaceRecord = {
      id: 'workspace',
      name: 'workspace',
      hostId: 'local',
      path: root,
      kind: 'folder'
    }
    const files = new WorkspaceFiles(() => host)

    for (let depth = 0; depth < 64; depth += 1) {
      const prefix = Array.from({ length: depth }, (_, index) => `segment-${index}`).join('/')
      const ascent = Array.from({ length: depth + 1 }, () => '..').join('/')
      const base = [prefix, ascent, 'outside'].filter(Boolean).join('/')
      await expect(files.read(workspace, `${base}/secret.txt`)).resolves.toMatchObject({
        status: 'error',
        message: 'Path escapes the workspace root'
      })
      await expect(files.create(workspace, { path: `${base}/created-${depth}`, kind: 'file' }))
        .rejects.toThrow('Path escapes the workspace root')
    }

    await expect(files.read(workspace, join(outside, 'secret.txt'))).resolves.toMatchObject({
      status: 'error',
      message: 'Path escapes the workspace root'
    })
    await expect(access(join(outside, 'created-0'))).rejects.toThrow()
  })
})
