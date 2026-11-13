import { expect, it } from 'vitest'
import { surveyBrowserControl } from '../src/renderer/src/lib/survey-workface'
import type { BrowserWorkbenchSurface } from '../src/renderer/src/lib/workbench-tabs'

const live: BrowserWorkbenchSurface = {
  kind: 'browser', regionId: 'page-region', workspaceId: 'workspace', browserId: 'page', id: 'page', mode: 'normal', navigationId: 'navigation',
  profileId: 'default', url: 'https://parked.test/', title: 'Parked page', loading: false, canGoBack: false, canGoForward: false,
  viewport: 'responsive', driving: false, appLinkPrompt: null, error: null, activity: { control: 'human', operation: null }
}

it('treats a confirmed release and a cold page that was not created as parked', () => {
  expect(surveyBrowserControl({ ...live, nativeOwnerReleased: true }, false)).toBe('parked')
  expect(surveyBrowserControl({ ...live, navigationId: '', activity: undefined, nativeOwnerDeferred: true }, false)).toBe('parked')
})

it('keeps an unavailable owner and an unconfirmed Region unknown even when the page was parked', () => {
  expect(surveyBrowserControl({ ...live, nativeOwnerReleased: true, nativeOwnerUnavailable: true }, false)).toBe('unknown')
  expect(surveyBrowserControl({ ...live, nativeOwnerDeferred: true }, true)).toBe('unknown')
  expect(surveyBrowserControl({ ...live, nativeOwnerUnavailable: true }, false)).toBe('unknown')
})

it('keeps a live page without a confirmed navigation or activity unknown, and reports live control', () => {
  expect(surveyBrowserControl({ ...live, navigationId: '' }, false)).toBe('unknown')
  expect(surveyBrowserControl({ ...live, activity: undefined }, false)).toBe('unknown')
  expect(surveyBrowserControl(live, false)).toBe('human')
  expect(surveyBrowserControl({ ...live, driving: true }, false)).toBe('agent')
  expect(surveyBrowserControl({ ...live, activity: { control: 'agent', operation: null } }, false)).toBe('idle')
})
