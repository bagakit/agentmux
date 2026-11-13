import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { moteOwnedWorkspaceRoots } from '../src/mote-resources.js'

/**
 * The Host tells Core which directories it owns, so Core pre-trusts a Provider only there.
 * The roots come from the one local Scratch workspace of the original configuration; anything
 * ambiguous or missing yields no owned root, which keeps every Provider's native trust prompt.
 */
describe('Host-owned workspace roots', () => {
  let root: string, config: string
  const write = (value: unknown) => writeFile(config, JSON.stringify(value))
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'amx-owned-roots-')); config = join(root, 'config.json') })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('lists the legacy Scratch, Topic and Mote roots of the local Scratch workspace', async () => {
    await write({ workspaces: [{ id: '__scratch__', hostId: 'local', path: '/home/u/.agentmux/scratch' },
      { id: 'project', hostId: 'local', path: '/home/u/code/app' }] })
    expect(await moteOwnedWorkspaceRoots(config)).toEqual(['/home/u/.agentmux/scratch', '/home/u/.agentmux/topics', '/home/u/.agentmux/motes'])
  })

  it('owns nothing when the Scratch workspace is remote, duplicated or absent', async () => {
    await write({ workspaces: [{ id: '__scratch__', hostId: 'remote', path: '/srv/scratch' }] })
    expect(await moteOwnedWorkspaceRoots(config)).toEqual([])
    await write({ workspaces: [{ id: '__scratch__', hostId: 'local', path: '/a' }, { id: '__scratch__', hostId: 'local', path: '/b' }] })
    expect(await moteOwnedWorkspaceRoots(config)).toEqual([])
    await write({ workspaces: [] })
    expect(await moteOwnedWorkspaceRoots(config)).toEqual([])
  })
})
