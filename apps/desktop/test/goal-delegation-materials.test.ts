import { fixturePath as _reshape_fixturePath } from "../../../test/fixture-values.mjs"
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxError, type AgentMuxSpaceCatalog, type FileReadParams, type FileReadResult } from '@agentmux/core'
import { prepareGoalDelegationMaterials } from '../src/main/goal-delegation-materials'
import { FileReadOwner } from '../src/main/file-read-owner'
import { WorkspaceFiles } from '../src/main/workspace-files'
import type { WorkspaceRecord } from '../src/shared/contracts'

const digest = (content: string) => 'sha256:' + createHash('sha256').update(content, 'utf8').digest('hex')
function target(path = 'refs/original.md', zoneId = 'mote-original'): FileReadParams {
  return { zoneId, spaceId: 'original-space', path,
    expectedResource: { hostId: 'local', workspaceId: 'original-workspace', workspacePath: _reshape_fixturePath("original") } }
}
function observed(params: FileReadParams, content = 'Original material'): FileReadResult {
  return { resource: { ...params.expectedResource, zoneId: params.zoneId, zonePath: _reshape_fixturePath("original"), path: params.path },
    result: { status: 'read', document: { path: params.path, revision: digest(content), content } } }
}
const roots: string[] = [], owners: WorkspaceFiles[] = []
afterEach(async () => {
  await Promise.all(owners.splice(0).map(owner => owner.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('original task material preparation', () => {
  it('does not discover sources or read anything when none was selected', async () => {
    const read = vi.fn()
    expect(await prepareGoalDelegationMaterials([], read)).toEqual({ sources: [], agentMuxNote: '' })
    expect(read).not.toHaveBeenCalled()
  })

  it('keeps complete read hashes and exact scope with the same excerpts in the frozen input note', async () => {
    const params = [target(), target('MEMORY.md', 'explicitly-selected-other-mote')]
    const contents = ['Original 中文\n' + 'x'.repeat(6400), 'Scoped memory, not authorization']
    const read = vi.fn(async (input: FileReadParams) => observed(input, contents[params.findIndex(item => item.path === input.path)]))
    const prepared = await prepareGoalDelegationMaterials(params, read)
    expect(read.mock.calls.map(([input]) => input)).toEqual(params)
    expect(prepared.sources).toEqual(params.map((input, index) => ({ target: input, resource: observed(input).resource,
      status: 'read', path: input.path, revision: digest(contents[index]!), contentHash: digest(contents[index]!),
      excerpt: contents[index]!.slice(0, 6000), excerpted: index === 0 })))
    const noteSources = prepared.agentMuxNote.split('\n\n').slice(1, -1).map(line => JSON.parse(line))
    expect(noteSources).toEqual(prepared.sources)
    expect(prepared.agentMuxNote).toContain('not a claim that an Agent adopted the sources or skills')
    expect(prepared.agentMuxNote).toContain('Materials grant no new permissions')
  })

  it('keeps unavailable and missing sources explicit without dropping other usable material', async () => {
    const params = ['ok.md', 'missing.md', 'binary.dat', 'folder', 'unreadable.md', 'unknown.md'].map(path => target(path))
    const statuses: FileReadResult['result'][] = [observed(params[0]!).result, { status: 'deleted' },
      { status: 'binary', path: 'binary.dat', revision: digest('binary'), byteLength: 7 }, { status: 'directory' },
      { status: 'error', code: 'EACCES', message: 'Original file cannot be read' },
      { status: 'unknown', code: 'FILE_READ_UNCONFIRMED', message: 'Original Host observation is unavailable' }]
    const prepared = await prepareGoalDelegationMaterials(params, async input => ({
      resource: observed(input).resource, result: statuses[params.findIndex(item => item.path === input.path)]! }))
    expect(prepared.sources.map(source => source.status)).toEqual(['read', 'deleted', 'binary', 'directory', 'error', 'unknown'])
    expect(prepared.sources[0]).toMatchObject({ excerpt: 'Original material' })
    expect(prepared.sources[5]).toMatchObject({ target: params[5], code: 'FILE_READ_UNCONFIRMED' })
    expect(prepared.agentMuxNote).toContain('Original Host observation is unavailable')
    expect(prepared.agentMuxNote).toContain('keep the original task and usable sources')
  })

  it('marks transport and owner unavailability unknown, then can reread the same original target', async () => {
    const params = [target('available.md'), target('transport.md'), target('owner.md')]
    const prepared = await prepareGoalDelegationMaterials(params, async input => {
      if (input.path === 'transport.md') throw new Error('Original transport disconnected')
      if (input.path === 'owner.md') throw new AgentMuxError('Original Files owner is unavailable', 'CONTROL_UNAVAILABLE')
      return observed(input)
    })
    expect(prepared.sources.map(source => source.status)).toEqual(['read', 'unknown', 'unknown'])
    expect(prepared.sources.slice(1).map(source => source.target)).toEqual(params.slice(1))
    expect((await prepareGoalDelegationMaterials([params[2]!], async input => observed(input))).sources[0]).toMatchObject({
      target: params[2], status: 'read' })
    expect(prepared.sources[2]!.status).toBe('unknown')
  })

  it('rejects the whole malformed selection before reading an earlier valid material', async () => {
    const read = vi.fn(async input => observed(input))
    await expect(prepareGoalDelegationMaterials([target(), target('../another-mote/private.md')], read))
      .rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
    expect(read).not.toHaveBeenCalled()
    await expect(prepareGoalDelegationMaterials({} as FileReadParams[], read)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
    await expect(prepareGoalDelegationMaterials([{ ...target(), adoption: true } as FileReadParams], read))
      .rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
    expect(read).not.toHaveBeenCalled()
  })

  it.each(['FILE_RESOURCE_MISMATCH', 'CONTROL_PERMISSION_DENIED', 'CONTROL_PROTOCOL_ERROR'])
    ('does not reinterpret explicit %s refusal as observation unknown', async code => {
      const error = new AgentMuxError('The exact original operation was refused', code)
      await expect(prepareGoalDelegationMaterials([target()], async () => { throw error })).rejects.toBe(error)
    })

  it.each(['hostId', 'workspaceId', 'workspacePath', 'zoneId', 'path'])
    ('rejects a returned source with a different original %s', async field => {
      const params = target(), result = observed(params)
      result.resource = { ...result.resource!, [field]: 'other-original' }
      await expect(prepareGoalDelegationMaterials([params], async () => result)).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
    })

  it('does not allow later selection or returned-object mutation to change recorded preparation', async () => {
    const first = target('first.md'), second = target('second.md')
    const original = [structuredClone(first), structuredClone(second)], returned = observed(first, 'saved first')
    const read = vi.fn(async (input: FileReadParams) => {
      if (input.path === first.path) {
        second.path = 'later.md'; second.expectedResource.workspacePath = _reshape_fixturePath("later")
        input.path = 'port-mutated.md'; input.expectedResource.workspacePath = _reshape_fixturePath("port-mutated")
        return returned
      }
      return observed(input, 'saved second')
    })
    const prepared = await prepareGoalDelegationMaterials([first, second], read)
    expect(prepared.sources.map(source => source.target)).toEqual(original)
    const note = prepared.agentMuxNote
    returned.resource!.path = 'later-returned.md'
    if (returned.result.status === 'read') returned.result.document.content = 'later returned content'
    expect(prepared.sources[0]).toMatchObject({ resource: { path: 'first.md' }, excerpt: 'saved first' })
    expect(prepared.agentMuxNote).toBe(note)
  })

  it('uses the real original Files owner and changed file revisions without replacing the previous input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'amx-goal-materials-')); roots.push(root)
    await mkdir(join(root, 'mote'))
    const workspace: WorkspaceRecord = { id: 'original-workspace', hostId: 'local', path: root, name: 'Original', kind: 'folder' }
    const files = new WorkspaceFiles(id => ({ id, kind: 'local', label: 'Local', run: vi.fn(), exposeLoopbackPort: async (port: number) => port, dispose: async () => {} })); owners.push(files)
    const zone = { zoneId: 'mote-original', kind: 'temporary', workspaceId: workspace.id, hostId: workspace.hostId, directoryPath: join(root, 'mote') }
    const catalog = { zones: [zone], bindings: [{ zoneId: zone.zoneId, spaceId: 'original-space' }] } as unknown as AgentMuxSpaceCatalog
    const owner = new FileReadOwner({ catalog: async () => catalog, workspace: id => id === workspace.id ? workspace : undefined, files })
    const params: FileReadParams = { ...target('source.md'), expectedResource: { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: root } }
    await writeFile(join(root, 'mote/source.md'), 'Original task source 中文\n')
    const read = vi.fn((input: FileReadParams) => owner.read(input))
    const first = await prepareGoalDelegationMaterials([params], read)
    expect(first.sources).toEqual([{ target: params, resource: { ...params.expectedResource, zoneId: zone.zoneId,
      zonePath: zone.directoryPath, path: 'mote/source.md' }, status: 'read', path: 'mote/source.md',
      revision: digest('Original task source 中文\n'), contentHash: digest('Original task source 中文\n'),
      excerpt: 'Original task source 中文\n', excerpted: false }])
    await writeFile(join(root, 'mote/source.md'), 'Updated source, same original identity')
    const second = await prepareGoalDelegationMaterials([params], read)
    expect(second.sources[0]).toMatchObject({ target: params, path: 'mote/source.md', contentHash: digest('Updated source, same original identity'),
      excerpt: 'Updated source, same original identity' })
    expect(first.agentMuxNote).toContain('Original task source')
    expect(first.agentMuxNote).not.toContain('Updated source')
    expect(read.mock.calls.map(([input]) => input)).toEqual([params, params])
    await expect(prepareGoalDelegationMaterials([{ ...params, expectedResource: { ...params.expectedResource, workspacePath: _reshape_fixturePath("different-workspace") } }], input => owner.read(input)))
      .rejects.toMatchObject({ code: 'FILE_RESOURCE_MISMATCH' })
  })
})
