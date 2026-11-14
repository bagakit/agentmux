import { contextBridge, ipcRenderer } from 'electron'
import { CAPTURE_SEQUENCE_CHANNEL, CAPTURE_SEQUENCE_CLOSE_REQUESTED, type CaptureSequenceApi } from '../shared/capture-sequence'
if (process.isMainFrame) {
  const call = (action: string, requestId?: string, input = {}) => ipcRenderer.invoke(CAPTURE_SEQUENCE_CHANNEL, action, { requestId, ...input })
  const api: CaptureSequenceApi = {
    load: () => call('load'), retake: id => call('retake', id),
    onCloseRequested: listener => { const receive = () => listener(); ipcRenderer.on(CAPTURE_SEQUENCE_CLOSE_REQUESTED, receive); return () => { ipcRenderer.removeListener(CAPTURE_SEQUENCE_CLOSE_REQUESTED, receive) } }, sample: id => call('sample', id), start: (id, fps) => call('start', id, { fps }),
    stop: id => call('stop', id), inspect: (id, afterFrames) => call('inspect', id, { afterFrames }), undo: id => call('undo', id),
    finishScroll: (id, image) => call('finish-scroll', id, { image }), saveGif: (id, data) => call('save-gif', id, { data }),
    openGif: id => call('open-gif', id), attachGif: (id, data) => call('attach-gif', id, { data }), cancel: id => call('cancel', id)
  }
  contextBridge.exposeInMainWorld('captureSequence', api)
}
