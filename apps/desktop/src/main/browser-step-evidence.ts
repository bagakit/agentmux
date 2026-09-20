import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { durableWriteFile } from '@agentmux/core'
import type { BrowserPageSnapshot, BrowserScreenshotCapture } from '../shared/contracts.js'
import type {
  BrowserEvidenceIdentity,
  BrowserStepEvidenceContent,
  BrowserStepEvidenceItem,
  BrowserStepEvidenceReference
} from '../shared/browser-step-evidence.js'

const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024
const MAX_STORE_BYTES = 64 * 1024 * 1024
const MAX_PAYLOADS = 128
const MAX_PAGE_NODES = 128
const MAX_PAGE_CHARS = 32_768
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SCHEMA = 'agentmux.browser-step-evidence.v1'

function sameIdentity(a: BrowserEvidenceIdentity, b: BrowserEvidenceIdentity): boolean {
  return a.operationId === b.operationId && a.sequence === b.sequence &&
    a.browserId === b.browserId && a.navigationId === b.navigationId
}

/** Payload files are not another journal: only a journal reference grants access to one. */
export class BrowserStepEvidenceStore {
  private tail: Promise<unknown> = Promise.resolve()
  private loaded = false
  private files = new Map<string, { bytes: number; at: number }>()

  constructor(private readonly directory: string) {}

  async write(identity: BrowserEvidenceIdentity, content: BrowserStepEvidenceContent): Promise<BrowserStepEvidenceReference> {
    const write = this.tail.catch(() => {}).then(async () => {
      await this.ready()
      const id = randomUUID()
      const bytes = Buffer.byteLength(JSON.stringify(content))
      const reference: BrowserStepEvidenceReference = {
        ...identity, id, kind: content.kind, capturedAt: Date.now(), byteLength: bytes,
        ...(content.kind === 'page' && content.truncated ? { truncated: true } : {})
      }
      const document = JSON.stringify({ schema: SCHEMA, reference, content })
      const size = Buffer.byteLength(document)
      if (size > MAX_PAYLOAD_BYTES) throw new Error('Step evidence exceeds its storage budget.')
      // Remove only files owned by this store. Old journal references then honestly become unavailable.
      for (const [oldId] of [...this.files].sort((a, b) => a[1].at - b[1].at)) {
        const total = [...this.files.values()].reduce((sum, file) => sum + file.bytes, 0)
        if (this.files.size < MAX_PAYLOADS && total + size <= MAX_STORE_BYTES) break
        await rm(join(this.directory, `${oldId}.json`), { force: true })
        this.files.delete(oldId)
      }
      await durableWriteFile(join(this.directory, `${id}.json`), document)
      this.files.set(id, { bytes: size, at: reference.capturedAt })
      return reference
    })
    this.tail = write
    return await write
  }

  async read(reference: BrowserStepEvidenceReference): Promise<BrowserStepEvidenceItem> {
    if (!ID.test(reference.id)) throw new Error('Invalid step evidence identity.')
    const file = await open(join(this.directory, `${reference.id}.json`), 'r')
    try {
      // Read with a fixed buffer, rather than trusting a mutable on-disk file size.
      const buffer = Buffer.alloc(Math.min((await file.stat()).size + 1, MAX_PAYLOAD_BYTES + 1))
      let length = 0
      while (length < buffer.length) {
        const read = await file.read(buffer, length, buffer.length - length, length)
        if (read.bytesRead === 0) break
        length += read.bytesRead
      }
      if (length > MAX_PAYLOAD_BYTES) throw new Error('Stored step evidence exceeds its read budget.')
      const value = JSON.parse(buffer.toString('utf8', 0, length)) as {
        schema?: string; reference?: BrowserStepEvidenceReference; content?: BrowserStepEvidenceContent
      }
      if (value.schema !== SCHEMA || !value.reference || !value.content ||
          value.reference.id !== reference.id || !sameIdentity(value.reference, reference) ||
          value.content.kind !== reference.kind || value.reference.kind !== reference.kind ||
          value.reference.capturedAt !== reference.capturedAt ||
          Buffer.byteLength(JSON.stringify(value.content)) !== reference.byteLength) {
        throw new Error('Stored evidence does not belong to this operation step.')
      }
      return { reference, content: value.content }
    } finally { await file.close() }
  }

  private async ready(): Promise<void> {
    if (this.loaded) return
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const names = await readdir(this.directory)
    for (const name of names) {
      const id = name.replace(/\.json$/, '')
      if (name !== `${id}.json` || !ID.test(id)) continue
      const info = await stat(join(this.directory, name))
      if (info.isFile()) this.files.set(id, { bytes: info.size, at: info.mtimeMs })
    }
    this.loaded = true
  }
}

/** Save only explicit observations or a generated diagnostic; never arbitrary js/CDP results. */
export async function recordBrowserStepEvidence(
  store: BrowserStepEvidenceStore,
  identity: BrowserEvidenceIdentity,
  content: BrowserStepEvidenceContent
): Promise<BrowserStepEvidenceReference> {
  return await store.write(identity, content)
}

export function pageStepEvidence(snapshot: BrowserPageSnapshot): BrowserStepEvidenceContent {
  const nodes = snapshot.nodes.slice(0, MAX_PAGE_NODES)
  const lines = nodes.map(node => `${node.ref} ${node.role}: ${node.name.slice(0, 240)}`)
  // Persist no input values, backend ids, cookies, URL credentials/query, or raw protocol payloads.
  let text = `${snapshot.title.slice(0, 240)}\n${lines.join('\n')}`
  const truncated = nodes.length !== snapshot.nodes.length || text.length > MAX_PAGE_CHARS
  text = text.slice(0, MAX_PAGE_CHARS)
  if (snapshot.missingFrames.length) text += `\n(${snapshot.missingFrames.length} frame(s) could not be read.)`
  return { kind: 'page', text, truncated }
}

export function screenshotStepEvidence(capture: BrowserScreenshotCapture): BrowserStepEvidenceContent {
  return { kind: 'screenshot', image: capture.image }
}
