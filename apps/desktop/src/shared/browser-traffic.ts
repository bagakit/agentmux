export type BrowserTrafficTarget = { id: string; title: string; url: string }
export type BrowserTrafficRow = {
  key: string
  browserId: string
  startedAt: string
  method: string
  url: string
  status: number
  duration: number
  state: 'pending' | 'finished' | 'failed' | 'redirect'
  mimeType: string
  redirectURL: string
}
export type BrowserTrafficReceipt = {
  captureId: string
  status: 'starting' | 'recording' | 'stopping' | 'finished'
  startedAt: number
  endedAt: number | null
  sources: (BrowserTrafficTarget & { status: 'starting' | 'recording' | 'finished' | 'unavailable'; detail?: string })[]
  rows: BrowserTrafficRow[]
  retained: number
  dropped: number
  unmatched: number
  pending: number
}
