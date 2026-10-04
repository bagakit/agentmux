import { readStructuredPreview, type StructuredDataKind } from './data-parse'

self.onmessage = (event: MessageEvent<{ id: string; kind: StructuredDataKind; content: string }>) => {
  const { id, kind, content } = event.data
  void readStructuredPreview(kind, content).then(parsed => self.postMessage({ id, parsed }), () => self.postMessage({ id, parsed: { status: 'invalid', message: 'Unable to read this preview. The complete source remains editable.' } }))
}
