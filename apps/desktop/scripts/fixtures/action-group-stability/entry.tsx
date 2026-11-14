import { createClientUiRoot } from '../../../test/helpers/client-ui-render'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { SettingsPanel } from '../../../src/renderer/src/components/SettingsPanel'
import { resolveBrowserStartPage } from '../../../src/shared/browser-start-page'
import '../composer-pending-delivery/entry'

const editQueued = useAppStore.getState().editQueuedAgentSteer
const edits: Parameters<typeof editQueued>[] = []
const settings: Array<{ value: string; expected: string }> = []
let holdEdit = false
let publishEdit: (() => void) | undefined
let settleEdit: (() => void) | undefined
let settleSettings: ((error?: Error) => void) | undefined

useAppStore.setState({ editQueuedAgentSteer: (...args) => {
  if (!holdEdit) return editQueued(...args)
  edits.push(args)
  return new Promise<void>((resolve, reject) => {
    publishEdit = () => {
      try {
        editQueued(...args)
        settleEdit = resolve
      } catch (error) { settleEdit = () => reject(error) }
    }
  })
} })
api.config.save = async (updated, baseline) => {
  settings.push({ value: resolveBrowserStartPage(updated.browser.startPage).title,
    expected: resolveBrowserStartPage(baseline?.browser.startPage).title })
  if (settleSettings) throw Error('An original settings request is already in flight')
  return new Promise((resolve, reject) => {
    settleSettings = error => error ? reject(error) : resolve(updated)
  })
}

const settingsNode = document.createElement('div')
settingsNode.hidden = true
document.body.append(settingsNode)
const settingsRoot = createClientUiRoot(settingsNode)
Object.assign(window, { actionGroup: {
  beginHoldingEdit() { holdEdit = true },
  publishEdit() {
    const publish = publishEdit
    if (!publish) throw Error('The actual edit callback has not arrived')
    publishEdit = undefined
    publish()
  },
  releaseEdit() {
    const release = settleEdit
    if (!release) throw Error('The original queue has not settled the edit')
    settleEdit = undefined; holdEdit = false; release()
  },
  revise(...args: Parameters<typeof editQueued>) { editQueued(...args) },
  openSettings() {
    settingsNode.hidden = false
    document.getElementById('root')!.hidden = true
    settingsRoot.render(<SettingsPanel initialSection="survey" onClose={() => { settingsNode.hidden = true }} />)
  },
  releaseSettings(error?: string) {
    const release = settleSettings
    if (!release) throw Error('The actual settings port has not received a request')
    settleSettings = undefined; release(error ? new Error(error) : undefined)
  },
  facts() { return { edits, settings } }
} })
