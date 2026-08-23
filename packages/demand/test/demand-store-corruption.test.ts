import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDemandStore } from '../src/demand-store.js'
import { DemandStoreError } from '../src/errors.js'

describe('DemandStore corruption handling', () => {
  it('fails closed with stage and path when store JSON is malformed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agentmux-demand-corrupt-'))
    await writeFile(path.join(root, 'store.json'), '{broken', 'utf8')
    const store = openDemandStore({ root })
    await expect(store.list()).rejects.toSatisfy((error: unknown) => {
      return error instanceof DemandStoreError && error.code === 'INVALID_SNAPSHOT' && error.phase === 'read' && error.path.endsWith('/store.json')
    })
  })

  it('rejects a valid JSON document with the wrong schema rather than returning an empty list', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agentmux-demand-schema-'))
    await writeFile(path.join(root, 'store.json'), JSON.stringify({ schema: 'wrong', revision: 0, updatedAt: Date.now(), demands: [] }), 'utf8')
    const store = openDemandStore({ root })
    await expect(store.list()).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT', phase: 'validate' })
  })
})
