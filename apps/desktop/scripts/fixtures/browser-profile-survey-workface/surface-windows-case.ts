import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BrowserWindow } from 'electron'
import { nativeInput, nativeUntil } from './native-input'
import { surfaceWindowNavigation } from './surface-window-navigation'

type Surface = 'survey' | 'recall'
type Context = {
  phase: string; directory: string; window: BrowserWindow; workspaceId: string; pageUrl: string; receipt: any
  core: { statusAgent(sessionId: string): Promise<{ run?: { runId: string; state: string; pid?: number } }> }
  result(args: string[], input?: string): Promise<any>
  cli(args: string[]): Promise<any>
  evaluate(expression: string): Promise<any>
}

const surfaces: Surface[] = ['survey', 'recall']
const notesText = 'Keep this note beside the research page and Focus.'
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const title = (surface: Surface) => surface === 'survey' ? 'Survey' : 'Recall'

export async function surfaceWindowsCase({ phase, directory, window, result, cli, evaluate, workspaceId, pageUrl, core, receipt }: Context) {
  const inputs: any[] = []
  const main = nativeInput(window.webContents, inputs)
  const attached = [main]
  const facts = () => evaluate('profileSurveyNative.read()')
  const capture = async (win: BrowserWindow, name: string) => {
    await pause(180)
    const file = phase + '-' + name + '.png'
    const rows = (await result(['app', 'window', 'ls'])).windows
    const targetId = win === window ? null : new URL(win.webContents.getURL()).searchParams.get('window')
    const descriptor = rows.find((row: any) => targetId ? row.windowId === targetId : row.target === null)
    assert.ok(descriptor?.documentGeneration, 'Capture the exact known window document')
    const target = { windowId: descriptor.windowId, documentGeneration: descriptor.documentGeneration }
    const frame = await result(['app', 'capture', '--input', '-', '--output', join(directory, file)], JSON.stringify({ target }))
    receipt.frames.push({ file, bounds: win.getBounds(), target, frame })
  }
  const observeWindows = () => result(['app', 'window', 'ls'])
  const detached = async (surface: Surface) => {
    const descriptor = await nativeUntil(async () => (await observeWindows()).windows.find((entry: any) =>
      entry.target?.kind === 'surface' && entry.target.surface === surface && entry.presentation === 'visible'), 'visible ' + surface + ' window descriptor')
    const win = await nativeUntil(() => BrowserWindow.getAllWindows().find(candidate => {
      const url = new URL(candidate.webContents.getURL() || 'about:blank')
      return url.searchParams.get('window') === descriptor.windowId && url.searchParams.get('document') === descriptor.documentGeneration
    }), 'exact ' + surface + ' native document')
    const inWindow = nativeInput(win.webContents, inputs)
    attached.push(inWindow)
    await nativeUntil(() => inWindow.read(`document.querySelector('.global-${surface}-surface')?.checkVisibility()`), 'complete visible ' + surface)
    return { win, inWindow, descriptor }
  }
  const priorFile = join(directory, 'surface-window-identities.json')
  const work = 'button[aria-label^="Focus: show execution contexts"]'
  const noteId = (input: ReturnType<typeof nativeInput>) => input.read("document.querySelector('.survey-notebook-page[data-selected=true]')?.dataset.noteId")
  try {
    let agent: { agentSessionId: string; runId: string }
    if (phase === 'first') {
      const original = await evaluate(`profileSurveyNative.prepareTask(${JSON.stringify(workspaceId)})`)
      const { zoneId, tabId, regionId } = original.workbenchSpaceSelection
      const opened = await result(['agent', 'open', '--executor', 'proof', '--execution-workspace', workspaceId,
        '--zone', zoneId, '--tab', tabId, '--region', regionId, '--split', 'right'])
      agent = { agentSessionId: opened.agent.agentSessionId, runId: opened.agent.runId }
      await main.click(work)
      await capture(window, 'main-focus')
      for (const surface of surfaces) {
        const nav = 'button[aria-label^="' + title(surface) + ':"]'
        if (surface === 'survey') {
          await main.click(nav, undefined, 'right')
          await capture(window, 'survey-context-menu')
          await main.click('[role="menuitem"]', 'Open Survey in separate window')
          await detached(surface)
          assert.equal((await facts()).mainSurface, 'agents', 'Opening directly from the navigation preserves Focus')
        } else {
          await main.click(nav)
          await capture(window, 'recall-window-entry')
          await main.click('[aria-label="Open Recall in separate window"]')
          await detached(surface)
          await main.click(work)
        }
      }
    } else agent = JSON.parse(await readFile(priorFile, 'utf8')).agent
    const survey = await detached('survey')
    const recall = await detached('recall')
    assert.notEqual(survey.descriptor.windowId, recall.descriptor.windowId)
    assert.equal((await facts()).mainSurface, 'agents', 'Focus remains usable beside the original knowledge windows')
    assert.equal((await observeWindows()).windows.length, 3)
    let selection: any
    if (phase === 'first') {
      await capture(survey.win, 'survey-start')
      await capture(recall.win, 'recall-start')
      await survey.inWindow.fill('[aria-label="Search or enter a web address"]', pageUrl)
      await survey.inWindow.key('Enter', 'Enter', 13)
      selection = await nativeUntil(async () => {
        const state = await facts()
        return state.surveySelection?.kind === 'page' ? state.surveySelection : null
      }, 'new page opened and selected inside Survey while Focus stays active')
      await nativeUntil(() => survey.win.contentView.children.find((view: any) =>
        view.webContents?.getURL() === pageUrl && !view.webContents.isLoading() && view.getVisible()), 'original native browser attached in Survey')
      await recall.inWindow.click('.survey-notebook-new-page')
      await nativeUntil(() => noteId(recall.inWindow), 'selected Note in detached Recall')
      await recall.inWindow.click('.ProseMirror[contenteditable=true]')
      await recall.win.webContents.debugger.sendCommand('Input.insertText', { text: notesText })
      for (const { descriptor } of [survey, recall]) {
        const opened = await result(['app', 'window', 'open', '--kind', 'surface', '--surface', descriptor.target.surface, '--background', '--operation-id', 'confirm-same-' + descriptor.target.surface])
        assert.equal(opened.recordedOperation.state, 'confirmed')
        assert.equal(opened.recordedOperation.windowId, descriptor.windowId, 'Opening again raises the same exact window')
      }
    } else {
      selection = (await facts()).surveySelection
    }
    await nativeUntil(() => recall.inWindow.read(`[...document.querySelectorAll('.ProseMirror')].some(e=>e.checkVisibility()&&e.textContent.includes(${JSON.stringify(notesText)}))`), 'the original Note body is visible and editable')
    await nativeUntil(() => survey.win.contentView.children.find((view: any) =>
      view.webContents?.getURL() === pageUrl && !view.webContents.isLoading() && view.getVisible()), 'live web page visible in original Survey window')
    if (phase === 'first') receipt.detachedNavigation = await surfaceWindowNavigation({ survey, recall,
      originalPage: selection, noteId: await noteId(recall.inWindow), notesText, pageUrl, evaluate, result, cli })
    const status = await core.statusAgent(agent.agentSessionId)
    assert.equal(status.run?.runId, agent.runId)
    assert.equal(status.run?.state, 'running')
    assert.ok(status.run?.pid && status.run.pid > 0)
    const actual = { agent, runPid: status.run.pid, surveyWindowId: survey.descriptor.windowId, recallWindowId: recall.descriptor.windowId, selection,
      noteId: await noteId(recall.inWindow), work: (await facts()).workbenchSpaceSelection, drafts: (await facts()).launcherDrafts }
    assert.ok(actual.noteId && actual.selection?.browserId && actual.selection?.regionId)
    assert.ok(Object.keys(actual.drafts).length, 'Original nonempty task input retained')
    assert.equal((await facts()).mainSurface, 'agents')
    if (phase === 'first') {
      for (const [surface, child] of [['survey',survey],['recall',recall]] as const) {
        await evaluate('profileSurveyNative.appearance("light")')
        child.win.setSize(1160, 760)
        await capture(child.win, surface + '-wide')
        await evaluate('profileSurveyNative.appearance("dark")')
        child.win.setSize(720, 480)
        await capture(child.win, surface + '-compact')
        await evaluate('profileSurveyNative.appearance("light")')
      }
      await evaluate('profileSurveyNative.checkpoint()')
      await writeFile(priorFile, JSON.stringify(actual))
      receipt.savedIdentity = actual
    } else {
      assert.deepEqual(actual, JSON.parse(await readFile(priorFile, 'utf8')), 'Original windows, page, note and work draft across native process restart')
      receipt.recoveredIdentity = actual
      // An ordinary system close returns the host while preserving Focus. Explicit
      // Return navigates to the corresponding original, still editable Note.
      survey.win.close()
      await nativeUntil(() => survey.win.isDestroyed(), 'native close returned Survey')
      assert.equal((await facts()).mainSurface, 'agents')
      await recall.inWindow.click('.workbench-window-toolbar button')
      await nativeUntil(() => recall.win.isDestroyed(), 'explicit Return closed the original Recall shell')
      await nativeUntil(() => evaluate(`document.querySelector('.global-recall-surface')?.checkVisibility() && [...document.querySelectorAll('.ProseMirror')].some(e=>e.checkVisibility()&&e.textContent.includes(${JSON.stringify(notesText)}))`), 'edited original Note returned into main workbench')
      assert.equal((await observeWindows()).windows.length, 1)
      const bounds = await evaluate(`(() => {
        const surface = document.querySelector('.global-recall-surface').getBoundingClientRect()
        const main = document.querySelector('.workspace-main-surface').getBoundingClientRect()
        return { surfaceBottom: surface.bottom, mainBottom: main.bottom }
      })()`)
      assert.ok(Math.abs(bounds.mainBottom - bounds.surfaceBottom) < 2, 'Returned Recall fills the original working area down to the footer')
      await capture(window, 'recall-returned')
    }
    receipt.surfaceWindowInput = inputs
    receipt.cases.push({ kind: 'surface-windows', phase, passed: true })
  } catch (error) {
    receipt.surfaceWindowFailure = []
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      const entry = { id: win.id, url: win.webContents.getURL(), text: await win.webContents.executeJavaScript('document.body.innerText.slice(0, 2400)').catch(String) }
      receipt.surfaceWindowFailure.push(entry)
      await writeFile(join(directory, phase + '-window-' + win.id + '-failure.png'), (await win.capturePage()).toPNG())
    }
    throw error
  } finally { for (const input of attached) input.release() }
}
