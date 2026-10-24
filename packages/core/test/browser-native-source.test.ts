import { describe, expect, it } from 'vitest'
import { parseBrowserSource, parseBrowserTargetsResult } from '../src/control-browser-targets.js'

describe('native Browser source provenance', () => {
  const openedFrom = { browserId: 'original-page', navigationId: 'original-navigation', location: {
    displayWorkspaceId: 'display', groupId: 'group', tabId: 'original-tab', regionId: 'original-region'
  } }

  it('retains exact provenance through public target decoding without granting input', () => {
    const target = parseBrowserTargetsResult({ coverage: 'complete', targets: [{ id: 'child', workspaceId: 'execution',
      source: 'embedded', status: 'ready', navigationId: 'child-navigation', url: 'https://child.invalid/', title: 'Child',
      capabilities: ['snapshot'], openedFrom, control: { owner: 'human', activeOperationId: null, revision: 0, inputIsolation: 'inactive' } }] }).targets[0]!
    expect(target.openedFrom).toEqual(openedFrom)
    expect(target.id).toBe('child')
    expect(target.navigationId).toBe('child-navigation')
    expect(target.control?.owner).toBe('human')
  })

  it('retains known source Browser when no exact presentation was observed', () => {
    expect(parseBrowserSource({ browserId: 'original-page', navigationId: 'original-navigation' })).toEqual({
      browserId: 'original-page', navigationId: 'original-navigation'
    })
  })

  it.each([
    { ...openedFrom, browserId: '' },
    { ...openedFrom, navigationId: undefined },
    { ...openedFrom, location: { ...openedFrom.location, regionId: '' } },
    { ...openedFrom, location: { ...openedFrom.location, focused: true } },
    { ...openedFrom, authority: 'agent' }
  ])('rejects incomplete or invented source facts: %j', value => {
    expect(() => parseBrowserSource(value)).toThrow()
  })
})
