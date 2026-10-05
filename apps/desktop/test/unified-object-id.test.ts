import { promoteRegionToTab } from '../src/renderer/src/lib/promote-region-to-tab'
import { describe, expect, it } from 'vitest'
import { mintObjectId, isObjectId } from '@agentmux/core/object-id'
import { createWorkspaceLayout, removeTab } from '@agentmux/layout'
import { createWorkbenchTab, addWorkbenchRegion, fileTabId, initialWorkbenchRegionId, sessionTabId, documentKey } from '../src/renderer/src/lib/workbench-tabs'
import { fileWorkbenchIdentity, reduceFileSurfaceOpened, reduceFileRename, findFileRenameProjectionCollision, type FileWorkbenchState } from '../src/renderer/src/lib/file-workbench-state'
import { scratchTopicDirectoryName, scratchTopicIdFromDirectoryName, isScratchTopicId } from '../src/shared/scratch-topics'
import { createCommonActionPrompt } from '../src/renderer/src/lib/goals-common-actions'
function state(): FileWorkbenchState {
  const tab = createWorkbenchTab('file:old-workspace:src/old.ts', { regionId: 'region:original', kind: 'file', workspaceId: 'old-workspace', path: 'src/old.ts' })
  return { tabs: { [tab.id]: tab }, layouts: { 'old-workspace': createWorkspaceLayout('old-group', [tab.id]) }, documents: {},
    dirtyDocuments: {}, documentGenerations: {}, documentObservationGenerations: {}, documentIssues: {}, savingDocuments: {}, lastActiveFileByWorkspace: {}, fileExplorerStates: {} }
}
describe('new object identities and retained File owners', () => {
  it('allocates domain-separated fixed-width presentation identities and prompts through the public primitive', () => {
    const file = fileTabId('w', 'same'), session = sessionTabId('same'), region = initialWorkbenchRegionId(file)
    for (const id of [file, session, region, createCommonActionPrompt('Help', []).id]) expect(isObjectId(id)).toBe(true)
    expect(new Set([file, session, region]).size).toBe(3)
    expect(fileTabId('w', 'same')).toBe(file)
    expect(fileTabId('w:same', 'path')).not.toBe(fileTabId('w', 'same:path'))
  })
  it('reuses original file and Region facts and keeps both identities and drafts on rename', () => {
    const original = state(), tab = Object.values(original.tabs)[0]!, key = documentKey('old-workspace', 'src/old.ts')
    original.documents[key] = { path: 'src/old.ts', content: 'unsaved draft', revision: 'old-disk' }; original.dirtyDocuments[key] = true
    expect(fileWorkbenchIdentity(original, 'old-workspace', 'src/old.ts')).toEqual({ tabId: tab.id, regionId: 'region:original' })
    const opened = reduceFileSurfaceOpened(original, 'old-workspace', 'src/old.ts')
    expect(Object.keys(opened.tabs)).toEqual([tab.id])
    expect(opened.tabs[tab.id]!.layout.activeRegionId).toBe('region:original')
    const renamed = reduceFileRename(opened, 'old-workspace', 'src/old.ts', 'src/new.ts')
    expect(Object.keys(renamed.tabs)).toEqual([tab.id]); expect(renamed.tabs[tab.id]!.titleRegionId).toBe('region:original')
    expect(renamed.layouts).toBe(opened.layouts)
    expect(fileWorkbenchIdentity(renamed, 'old-workspace', 'src/new.ts')).toEqual({ tabId: tab.id, regionId: 'region:original' })
    expect(renamed.documents[documentKey('old-workspace', 'src/new.ts')]?.content).toBe('unsaved draft')
    expect(renamed.dirtyDocuments[documentKey('old-workspace', 'src/new.ts')]).toBe(true)
  })
  it('finds old File owners in another display and catches rename collisions by the original resource', () => {
    const original = state(), tab = Object.values(original.tabs)[0]!
    original.layouts = { 'other-display': createWorkspaceLayout('old-group', [tab.id]) }
    expect(fileWorkbenchIdentity(original, 'old-workspace', 'src/old.ts').tabId).toBe(tab.id)
    const other = createWorkbenchTab('view:retained-other', { regionId: 'retained-other-region', kind: 'file', workspaceId: 'old-workspace', path: 'src/new.ts' })
    original.tabs[other.id] = other
    expect(findFileRenameProjectionCollision(original, 'old-workspace', 'src/old.ts', 'src/new.ts')).toEqual({ owner: 'tab', path: 'src/new.ts' })
  })
  it('creates a new File with fixed-width IDs through the same actual reducer', () => {
    const result = reduceFileSurfaceOpened(state(), 'old-workspace', 'src/fresh.ts')
    const fresh = Object.values(result.tabs).find(tab => tab.id !== 'file:old-workspace:src/old.ts')!
    expect(isObjectId(fresh.id)).toBe(true); expect(isObjectId(fresh.titleRegionId)).toBe(true)
    expect(fileWorkbenchIdentity(result, 'old-workspace', 'src/fresh.ts')).toEqual({ tabId: fresh.id, regionId: fresh.titleRegionId })
  })
  it('keeps the renamed owner when its previous file path is opened as a new entity', () => {
    const empty = state(), opened = reduceFileSurfaceOpened(empty, 'old-workspace', 'foo.ts')
    const original = fileWorkbenchIdentity(opened, 'old-workspace', 'foo.ts'), key = documentKey('old-workspace', 'foo.ts')
    opened.documents[key] = { path:'foo.ts', content:'bar unsaved draft', revision:'disk' }; opened.dirtyDocuments[key] = true
    const renamed = reduceFileRename(opened, 'old-workspace', 'foo.ts', 'bar.ts'), bar = renamed.tabs[original.tabId]!
    const identity = fileWorkbenchIdentity(renamed, 'old-workspace', 'foo.ts')
    expect(identity.tabId).not.toBe(original.tabId); expect(identity).toEqual(fileWorkbenchIdentity(renamed, 'old-workspace', 'foo.ts'))
    const fresh = reduceFileSurfaceOpened(renamed, 'old-workspace', 'foo.ts')
    expect(fresh.tabs[original.tabId]).toBe(bar); expect(fresh.tabs[original.tabId]!.titleRegionId).toBe(original.regionId)
    expect(fresh.documents[documentKey('old-workspace','bar.ts')]?.content).toBe('bar unsaved draft')
    expect(fresh.dirtyDocuments[documentKey('old-workspace','bar.ts')]).toBe(true)
    expect(fresh.tabs[identity.tabId]?.regions[identity.regionId]).toMatchObject({kind:'file',path:'foo.ts'})
    const again = reduceFileSurfaceOpened(fresh, 'old-workspace', 'foo.ts')
    expect(fileWorkbenchIdentity(again,'old-workspace','foo.ts')).toEqual(identity)
    expect(Object.keys(again.tabs)).toEqual(Object.keys(fresh.tabs)); expect(again.tabs[original.tabId]).toBe(bar)
  })
  it('does not reuse a freed deterministic Tab ID when its original Region survives promotion elsewhere', () => {
    const original = reduceFileSurfaceOpened(state(), 'old-workspace', 'foo.ts')
    const seed = fileWorkbenchIdentity(original, 'old-workspace', 'foo.ts'), tab = original.tabs[seed.tabId]!
    original.tabs[seed.tabId] = addWorkbenchRegion(tab,seed.regionId,'right',{kind:'launcher',workspaceId:'old-workspace',regionId:mintObjectId()})
    const result = promoteRegionToTab({...original,workspaceId:'old-workspace',tabId:seed.tabId,regionId:seed.regionId,mint:{tabId:'view:promoted-original'}})
    expect(result.kind).toBe('promoted'); if(result.kind!=='promoted')throw new Error('Original promotion did not apply')
    const promoted=result.tabs[result.target.tabId]!
    original.tabs=result.tabs; original.layouts=result.layouts
    delete original.tabs[seed.tabId]
    original.layouts['old-workspace']=removeTab(original.layouts['old-workspace']!, 'old-group', seed.tabId)
    const renamed = reduceFileRename(original,'old-workspace','foo.ts','bar.ts')
    expect(renamed.tabs[seed.tabId]).toBeUndefined()
    const next = fileWorkbenchIdentity(renamed,'old-workspace','foo.ts')
    expect(next.tabId).not.toBe(seed.tabId); expect(next.regionId).not.toBe(seed.regionId)
    const opened = reduceFileSurfaceOpened(renamed,'old-workspace','foo.ts')
    expect(opened.tabs[promoted.id]).toBe(renamed.tabs[promoted.id])
    expect(opened.tabs[promoted.id]!.regions[seed.regionId]).toMatchObject({kind:'file',path:'bar.ts'})
    expect(opened.tabs[next.tabId]!.regions[next.regionId]).toMatchObject({kind:'file',path:'foo.ts'})
    const regions=Object.values(opened.tabs).flatMap(tab=>Object.keys(tab.regions))
    expect(new Set(regions).size).toBe(regions.length)
  })
  it('roundtrips new and original Topic directory identities without rewriting their directory', () => {
    for (const id of [mintObjectId(), 'launcher:leader', 'view:original', 'session:old-session']) {
      expect(isScratchTopicId(id)).toBe(true)
      expect(scratchTopicIdFromDirectoryName(scratchTopicDirectoryName(id))).toBe(id)
    }
    const id = mintObjectId(); expect(scratchTopicDirectoryName(id)).toBe('topic--' + id)
    for (const id of ['../escape', '000000000000', 'short', 'view:../escape']) expect(isScratchTopicId(id)).toBe(false)
    expect(scratchTopicIdFromDirectoryName('topic--../escape')).toBeNull()
  })
})
