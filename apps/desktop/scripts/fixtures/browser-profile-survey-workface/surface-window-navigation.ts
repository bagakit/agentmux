import assert from 'node:assert/strict'
import type { BrowserWindow } from 'electron'
import type { AppWindowDescriptor } from '@agentmux/core/control'
import { nativeInput, nativeUntil } from './native-input'

type Child = { win: BrowserWindow; descriptor: AppWindowDescriptor; inWindow: ReturnType<typeof nativeInput> }

export async function surfaceWindowNavigation(input: {
  survey: Child; recall: Child; originalPage: { regionId: string; browserId: string }; noteId: string
  notesText: string; pageUrl: string; evaluate(expression: string): Promise<any>; result(args: string[], input?: string): Promise<any>
  cli(args: string[]): Promise<any>
}) {
  const { survey, recall, originalPage, noteId, notesText, pageUrl, evaluate, result, cli } = input
  const work = await evaluate('profileSurveyNative.read().workbenchSpaceSelection')
  const keepFocus = async (step: string) => {
    const state = await evaluate('profileSurveyNative.read()')
    assert.equal(state.mainSurface, 'agents', step + ' leaves main Focus selected')
    assert.deepEqual(state.workbenchSpaceSelection, work, step + ' preserves the original Work selection')
  }
  const noteEditor = () => recall.inWindow.read(`[...document.querySelectorAll('.ProseMirror')].some(e => e.checkVisibility() && e.textContent.includes(${JSON.stringify(notesText)}))`)
  const descriptor = async (id: string) => (await result(['app', 'window', 'ls'])).windows.find((row: AppWindowDescriptor) => row.windowId === id)
  await evaluate(`window.proofFocusOperations = new Map()
    window.stopProofFocus = profileSurveyNative.api.ui.workbenchWindows.onChanged(({recordedOperation: op}) => {
      if (op?.method === 'app.window.focus') window.proofFocusOperations.set(op.input.operationId, op)
    }); true`)
  const focusOperations = (): Promise<any[]> => evaluate('[...window.proofFocusOperations.values()]')

  const editorSelector = '.ProseMirror[contenteditable=true]'
  await recall.inWindow.read(`window.originalProofNoteEditor = [...document.querySelectorAll(${JSON.stringify(editorSelector)})].find(e => e.checkVisibility()); Boolean(window.originalProofNoteEditor)`)
  recall.win.minimize()
  const hidden = await nativeUntil(async () => {
    if (!recall.win.isMinimized()) return null
    const row = await descriptor(recall.descriptor.windowId)
    return row?.presentation === 'hidden' ? row : null
  }, 'actual minimized Recall and hidden original document receipt')
  await keepFocus('Minimizing Recall')
  recall.win.restore()
  const restored = await nativeUntil(async () => {
    if (recall.win.isMinimized()) return null
    const row = await descriptor(recall.descriptor.windowId)
    return row?.presentation === 'visible' && await noteEditor() ? row : null
  }, 'restored Recall has its original editor and text')
  assert.equal(await recall.inWindow.read('Boolean(window.originalProofNoteEditor?.checkVisibility() && window.originalProofNoteEditor.isContentEditable)'), true, 'the original editable DOM survives minimization')
  assert.equal(restored.documentGeneration, hidden.documentGeneration)

  await recall.inWindow.click('.notebook-breadcrumb')
  await nativeUntil(() => recall.inWindow.read("document.querySelector('.survey-notebook-home')?.checkVisibility()"), 'the Notebook directory presents inside its original Recall window')
  await keepFocus('Following the Notebook breadcrumb')
  assert.deepEqual(await focusOperations(), [], 'same-window Notebook navigation never requests native focus')
  await recall.inWindow.click('.survey-notebook-page[data-note-id="' + noteId + '"]')
  await nativeUntil(noteEditor, 'the original Note is reachable from its original Notebook')

  // Supply a real Notebook source, then drive the original page menu through the child.
  const sourceUrl = pageUrl + '?from=original-note'
  const change = { kind: 'source', noteId, source: { sourceId: 'private-note-source', url: sourceUrl,
    title: 'Detached note source', recordedAt: Date.now() } }
  const updated = await evaluate(`(async () => {
    const api = profileSurveyNative.api.notebooks
    const state = await api.read()
    return await api.apply({ expectedRevision: state.revision, operationId: 'attach-private-note-source', change: ${JSON.stringify(change)} })
  })()`)
  assert.ok(updated.pages[noteId].sources.some((source: { url: string }) => source.url === sourceUrl))
  await recall.inWindow.click('[aria-label="Page options"]')
  await recall.inWindow.click('[role="menuitem"][aria-label="Page sources"]')
  await recall.inWindow.click('[aria-label="Open source Detached note source"]')
  await nativeUntil(() => survey.win.contentView.children.some((view: any) =>
    view.webContents?.getURL() === sourceUrl && !view.webContents.isLoading() && view.getVisible()), 'the Note source loads in the existing Survey window')
  const sourceDestination = await nativeUntil(async () => (await focusOperations()).find(op =>
    op.windowId === survey.descriptor.windowId && op.documentGeneration === survey.descriptor.documentGeneration &&
    (op.state === 'confirmed' || op.state === 'unknown')), 'exact native foreground request for the Note source')
  assert.equal(sourceDestination.state, survey.win.isFocused() ? 'confirmed' : 'unknown')
  await keepFocus('Opening the Note source across windows')
  await recall.inWindow.click('[aria-label="Close page sources"]')
  await nativeUntil(noteEditor, 'the original Note remains editable after opening its source')

  const noteWindow = recall.descriptor
  const noteFocus = await cli(['app', 'window', 'focus', '--window', noteWindow.windowId,
    '--document-generation', noteWindow.documentGeneration, '--operation-id', 'focus-private-note-editor'])
  assert.equal(noteFocus.value.ok, true)
  assert.equal(noteFocus.value.result.recordedOperation.state, recall.win.isFocused() ? 'confirmed' : 'unknown')
  await recall.inWindow.click(editorSelector)
  const recallFocused = recall.win.isFocused()
  const originalEditor = 'document.activeElement?.isContentEditable'
  assert.equal(await recall.inWindow.read(originalEditor), true, 'the Note is the selected editor in its document')
  const priorFocusRequests = await focusOperations()
  const publicNavigation = []
  for (const [surface, child] of [['survey', survey], ['recall', recall]] as const) {
    const args = ['app', 'focus', '--surface', surface, '--input', 'preserve']
    if (surface === 'survey') args.push('--browser', originalPage.browserId, '--region', originalPage.regionId)
    const response = await cli(args)
    assert.equal(response.value.ok, true)
    const report = response.value.result
    assert.equal(response.code, report.partial ? 1 : 0)
    assert.ok(['applied', 'unchanged'].includes(report.navigation.state))
    assert.equal(report.navigation.selection.surface, 'focus')
    if (surface === 'survey') {
      assert.deepEqual(report.navigation.selection.survey, originalPage)
      await nativeUntil(() => survey.win.contentView.children.some((view: any) =>
        view.webContents?.getURL() === pageUrl && !view.webContents.isLoading() && view.getVisible()), 'public Survey navigation reselects the original native page')
    }
    assert.equal(report.presentation.surface, surface)
    assert.equal(report.presentation.state, 'window')
    assert.equal(report.presentation.windowId, child.descriptor.windowId)
    assert.equal(report.presentation.documentGeneration, child.descriptor.documentGeneration)
    assert.equal(report.input.policy, 'preserve')
    if (recallFocused) {
      assert.equal(report.input.outcome, 'preserved')
      assert.equal(report.input.before.windowId, noteWindow.windowId)
      assert.equal(report.input.after.documentGeneration, noteWindow.documentGeneration)
    } else {
      assert.ok(['unavailable', 'unconfirmed'].includes(report.input.outcome), 'an inactive test App cannot confirm native keyboard ownership')
      assert.ok(report.partial && report.issues.length > 0)
    }
    assert.equal(await recall.inWindow.read(originalEditor), true)
    assert.equal(recall.win.isFocused(), recallFocused)
    assert.deepEqual(await focusOperations(), priorFocusRequests, 'preserve navigation never issues a native focus request')
    await keepFocus('Public navigation to ' + surface)
    publicNavigation.push(report)
  }
  await evaluate('window.stopProofFocus(); true')
  return { noteId, originalPage, sourceUrl, sourceDestination, hidden, restored, publicNavigation, recallFocused, work }
}
