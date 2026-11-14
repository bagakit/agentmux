import { expect, it } from 'vitest'
import { workbenchReturnContext } from '../src/renderer/src/lib/workbench-return-context'
import { readWorkbenchReturnContext, workbenchReturnLabel } from '../src/shared/workbench-windows'
const reference = { displayWorkspaceId: 'display', groupId: 'group', tabId: 'tab', regionId: 'page' }
it('[window-return] original presentation scope replaces only the exact Browser caret', () => {
  const original = { zoneId: 'research', selection: [{ tabId: 'tab', regionId: 'file' }], active: { tabId: 'tab', regionId: 'file' } }
  const result = workbenchReturnContext({ surface: 'survey', returnSelection: original, reference: { ...reference, regionId: 'file' } }, reference)
  expect(result).toEqual({ surface: 'survey', reference, selection: { zoneId: 'research', selection: [{ tabId: 'tab', regionId: 'page' }], active: { tabId: 'tab', regionId: 'page' } } })
  expect(original.active.regionId).toBe('file')
})
it('[window-return] expanded exact page keeps its original Browser anchor', () => {
  const selection = { kind: 'page' as const, regionId: 'original-page', browserId: 'original-browser', presentation: { kind: 'tab' as const, ...reference } }
  const result = workbenchReturnContext({ surface: 'survey', returnSelection: selection, reference }, { ...reference, regionId: 'agent' })
  expect(result).toMatchObject({ selection: { regionId: 'original-page', browserId: 'original-browser', presentation: { regionId: 'agent' } } })
  expect(workbenchReturnContext({ surface: 'survey', reference })).toBeNull()
  expect(workbenchReturnLabel(result)).toBe('Return to Survey')
})
it('[window-return] a malformed or different target is unknown and never becomes a guessed Space', () => {
  expect(readWorkbenchReturnContext({ surface: 'survey', reference, selection: { kind: 'page' } })).toBeNull()
  expect(readWorkbenchReturnContext({ surface: 'focus', reference, view: 'region' }, { kind: 'region', ...reference, regionId: 'replacement' })).toBeNull()
  expect(workbenchReturnLabel(null)).toBe('Return to original view')
})
