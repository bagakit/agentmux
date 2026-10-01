import { createHash } from 'node:crypto'
import type { BrowserDemonstrationDraft, BrowserDemonstrationStep } from '../shared/browser-demonstration.js'
import { interpretBrowserDemonstrationStep, type BrowserDemonstrationInterpretation, type BrowserDemonstrationSuggestion } from '../shared/browser-demonstration-semantics.js'

function facts(step: BrowserDemonstrationStep): BrowserDemonstrationStep {
  return { id: step.id, sequence: step.sequence, recordedAt: step.recordedAt, navigationId: step.navigationId,
    source: step.source, method: step.method, url: step.url, args: [],
    ...(step.target ? { target: { role: step.target.role, name: step.target.name, count: step.target.count, ordinal: step.target.ordinal } } : {}),
    ...(step.inputKey ? { inputKey: step.inputKey } : {}) }
}
const digest = (step: BrowserDemonstrationStep) => createHash('sha256').update(JSON.stringify(facts(step))).digest('hex')

/** One recording projection. It owns suggestions, never original actions, editable assets or a Runtime. */
export class BrowserDemonstrationInterpreter {
  private subject: { browserId: string; recordingId: string; navigationId: string; status: BrowserDemonstrationDraft['status'] } | undefined
  private epoch = 0
  private entries = new Map<string, BrowserDemonstrationSuggestion>()
  private actualFacts = new Map<string, string>()
  private work = { requested: 0, applied: 0, discarded: 0 }
  constructor(private readonly onChange: (suggestions: BrowserDemonstrationSuggestion[]) => void,
    private readonly explain?: (step: BrowserDemonstrationStep) => Promise<BrowserDemonstrationInterpretation>) {}

  update(draft: BrowserDemonstrationDraft | null): BrowserDemonstrationSuggestion[] {
    const previous = this.subject
    const sameRecording = !!draft && previous?.recordingId === draft.id && previous.browserId === draft.browserId
    const invalidated = !draft || !sameRecording || previous?.navigationId !== draft.navigationId ||
      (previous.status === 'recording' && draft.status !== 'recording')
    if (invalidated) {
      this.epoch++
      if (!sameRecording) { this.entries.clear(); this.actualFacts.clear(); this.work = { requested: 0, applied: 0, discarded: 0 } }
      else for (const [id, entry] of this.entries) {
        if (entry.status === 'interpreting') this.entries.set(id, { ...entry, status: 'unknown', reason: 'The original interpretation was cancelled; recorded facts remain.' })
      }
    }
    this.subject = draft ? { browserId: draft.browserId, recordingId: draft.id, navigationId: draft.navigationId, status: draft.status } : undefined
    if (!draft) return []
    const retained = new Set(draft.steps.map(step => step.id))
    for (const id of this.entries.keys()) if (!retained.has(id)) { this.entries.delete(id); this.actualFacts.delete(id) }
    for (const step of draft.steps) {
      const factRevision = digest(step)
      this.actualFacts.set(step.id, factRevision)
      if (this.entries.get(step.id)?.factRevision === factRevision) continue
      const candidate: BrowserDemonstrationSuggestion = { stepId: step.id, factRevision, source: 'recorded-target-rule', status: 'interpreting' }
      // After navigation, a newly observed step belongs to its own document; older pending work never restarts automatically.
      if (sameRecording && (draft.status !== 'recording' || step.navigationId !== draft.navigationId)) {
        this.entries.set(step.id, { ...candidate, status: 'unknown', reason: 'This retained step needs a new interpretation; no page action was repeated.' }); continue
      }
      this.entries.set(step.id, candidate)
      const epoch = this.epoch, subject = this.subject!
      this.work.requested++
      void Promise.resolve().then(() => this.explain ? this.explain(facts(step)) : interpretBrowserDemonstrationStep(facts(step))).then(result => {
        if (this.epoch !== epoch || this.subject?.recordingId !== subject.recordingId || this.subject.browserId !== subject.browserId || this.actualFacts.get(step.id) !== factRevision ||
            this.entries.get(step.id)?.factRevision !== factRevision) { this.work.discarded++; return }
        this.entries.set(step.id, { ...result, stepId: step.id, factRevision })
        this.work.applied++; this.notify(step.id)
      }, () => {
        if (this.epoch !== epoch || this.subject?.recordingId !== subject.recordingId || this.subject.browserId !== subject.browserId || this.actualFacts.get(step.id) !== factRevision) { this.work.discarded++; return }
        this.entries.set(step.id, { ...candidate, status: 'failed', reason: 'Suggestion could not be prepared. Recorded facts and the Browser remain.' })
        this.notify(step.id)
      })
    }
    return this.state()
  }
  state(): BrowserDemonstrationSuggestion[] { return structuredClone([...this.entries.values()]) }
  getWork(): Readonly<{ requested: number; applied: number; discarded: number }> { return { ...this.work } }
  private notify(stepId: string): void {
    try { this.onChange(this.state()) }
    catch {
      const entry = this.entries.get(stepId)
      if (entry) this.entries.set(stepId, { ...entry, status: 'failed', reason: 'The suggestion update could not be published. Read it again; original work remains.' })
    }
  }
}
