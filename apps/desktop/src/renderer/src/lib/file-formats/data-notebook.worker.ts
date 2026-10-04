import { createNotebookReader, type NotebookReply, type NotebookRequest } from './data-notebook'

const endpoint = self as unknown as { onmessage: ((event: MessageEvent<NotebookRequest>) => void) | null; postMessage(reply: NotebookReply): void }
let reader: ReturnType<typeof createNotebookReader> | null = null
let job = ''
endpoint.onmessage = event => {
  const request = event.data
  if (request.type === 'open') { job = request.job; reader = createNotebookReader(request.content) }
  if (request.job !== job || !reader) return
  const page = request.type === 'page' ? request.page : 0
  try { endpoint.postMessage({ job, page, result: reader.page(page) }) }
  catch { endpoint.postMessage({ job, page, result: { status: 'invalid', message: 'Unable to read these notebook cells. The original source remains editable.' } }) }
}
