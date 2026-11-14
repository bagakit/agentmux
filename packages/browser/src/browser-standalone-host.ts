import { readBrowserOperationResult } from './browser-operation-result.js'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, open, readFile, stat, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import puppeteer, { type Browser, type Target, type CDPSession } from 'puppeteer-core'
import { z } from 'zod'
import { durableWriteFile, BROWSER_PAGE_CAPABILITY_NAMES, type AgentMuxBrowserTarget, type AgentMuxBrowserTargetsResult,
  type AgentMuxBrowserLifecycleIntent, type AgentMuxBrowserLifecycleReceipt, type AgentMuxControlRequest, type AgentMuxControlResult } from '@agentmux/core'
import { mintObjectId } from '@agentmux/core/object-id'
import { BrowserOperationJournal, BrowserOperationFileStore, browserOperationAlreadyExistsError } from './browser-operation-journal.js'
import { BrowserRefLedgerStore } from './browser-ref-ledger-store.js'
import { BrowserStepEvidenceStore } from './browser-step-evidence.js'
import { BrowserResultArtifactStore } from './browser-result-artifact.js'
import { BrowserProgramOwner } from './browser-program-owner.js'
import { OwnedBrowserTargetSession } from './browser-owned-cdp-target.js'
import { BrowserRequestFailure, type BrowserProgramPort, type BrowserProgramTarget } from './browser-program-port.js'

const text = z.string().min(1).max(8192)
const savedTarget = z.object({ id: text, targetId: text.nullable(), navigationId: z.string().max(8192), url: text, title: z.string().max(8192),
  status: z.enum(['ready','disconnected','revoked','closed','unavailable']), ledgerNavigationId: text.optional(), warning: text.optional() }).strict()
const registrySchema = z.object({ version: z.literal(1), engine: z.object({ profileDirectory: text, endpoint: text.optional() }).strict().nullable(), targets: z.array(savedTarget) }).strict()
type SavedTarget = z.infer<typeof savedTarget>
type Binding = SavedTarget & BrowserProgramTarget
/** Host policy, never supplied by an Agent program or inferred from human focus. */
export type StandaloneBrowserHostOptions = { directory: string; executablePath: string }

/** One standalone host owns native target identity; the shared program owner owns programs and receipts. */
export class StandaloneBrowserHost {
  readonly journal: BrowserOperationJournal
  readonly programs: BrowserProgramOwner
  private readonly bindings = new Map<string, Binding>()
  private readonly nativeTargets = new Map<string, Target>()
  private readonly targetBindings = new Map<Target, Binding>()
  private registryReadable = true
  private readonly monitors = new Map<string, CDPSession>()
  private readonly events = new Map<string, Set<Parameters<BrowserProgramPort['observe']>[1]>>()
  private readonly availability = new Map<string, Set<() => void>>()
  private engine: { profileDirectory: string; endpoint?: string | undefined } | null = null
  private browser: Browser | null = null
  private lock: FileHandle | null = null
  private browserSession: CDPSession | null = null
  private readyPromise: Promise<void> | null = null
  private launch: Promise<Browser> | null = null
  private reobserving: Promise<Browser | null> | null = null
  private retentionWarning: string | undefined
  private saveTail = Promise.resolve()
  private warning: string | undefined
  private stopped = false
  constructor(readonly options: StandaloneBrowserHostOptions) {
    if (!isAbsolute(options.directory) || !isAbsolute(options.executablePath)) throw new TypeError('Standalone Browser storage and executable paths must be explicit absolute paths.')
    this.journal = new BrowserOperationJournal(new BrowserOperationFileStore(join(options.directory, 'browser-operation-journal.json')))
    const port: BrowserProgramPort = {
      has: id => this.bindings.has(id), require: id => this.require(id), stopOperation: () => {},
      attach: async target => {
        const original = this.require(target.id), browser = this.browser
        if (original !== target || !browser || !original.targetId || original.status !== 'ready') throw new BrowserRequestFailure('The original native Browser is unavailable.', false)
        const native = this.nativeTargets.get(original.id)
        if (!native) throw new BrowserRequestFailure('The original native target is unavailable.', false)
        const connectionId = original.connection?.id
        const root = await native.createCDPSession()
        const session = new OwnedBrowserTargetSession(root, original, () => this.browser === browser && original.status === 'ready' && original.connection?.id === connectionId)
        try { await session.attach(); return session } catch (error) { await session.detach(); throw error }
      },
      observe: (id, fn) => this.listen(this.events, id, fn), observeAvailability: (id, fn) => this.listen(this.availability, id, fn),
      recordLedger: (id, navigationId) => { const target = this.require(id); if (target.navigationId === navigationId) { target.ledgerNavigationId = navigationId; void this.persist().catch(() => {}) } },
      dispose: () => this.disconnect()
    }
    this.programs = new BrowserProgramOwner(port, { journal: this.journal,
      refs: new BrowserRefLedgerStore(join(options.directory, 'browser-ref-ledger.json')),
      results: new BrowserResultArtifactStore(join(options.directory, 'results')),
      evidence: new BrowserStepEvidenceStore(join(options.directory, 'evidence')),
      validateScreenshot: () => {} })
  }
  private listen<T>(map: Map<string, Set<T>>, id: string, fn: T): () => void { const set = map.get(id) ?? new Set<T>(); map.set(id, set); set.add(fn); return () => { set.delete(fn); if (!set.size) map.delete(id) } }
  private require(id: string): Binding { const target = this.bindings.get(id); if (!target) throw new Error('This Browser does not belong to the current standalone host.'); return target }
  ready(): Promise<void> { return this.readyPromise ??= this.initialize() }
  private async initialize(): Promise<void> {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 })
    this.lock = await open(join(this.options.directory, 'browser-owner.lock'), 'a+', 0o600)
    const native = createRequire(import.meta.url)('fs-native-extensions') as { tryLock(fd: number): boolean }
    if (!native.tryLock(this.lock.fd)) { await this.lock.close(); this.lock = null; throw new Error('This standalone Browser directory already has its original live owner.') }
    await this.journal.ready()
    try {
      const state = registrySchema.parse(JSON.parse(await readFile(this.registryPath(), 'utf8')))
      this.engine = state.engine
      for (const row of state.targets) {
        const { ledgerNavigationId, warning, ...saved } = row
        this.bindings.set(saved.id, { ...saved, ...(ledgerNavigationId ? { ledgerNavigationId } : {}), ...(warning ? { warning } : {}), workspaceId: null, connection: null,
        status: saved.status === 'closed' ? 'closed' : saved.targetId && saved.navigationId ? 'disconnected' : 'unavailable', ...(saved.status === 'closed' ? {} : { warning: 'Reconnecting the original native Browser; no program is replayed.' }) })
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') { this.registryReadable = false; this.warning = 'Original Browser registry is unavailable. Existing engine and records are retained; repair the original storage before creating a Browser.'; return }
    }
    if (!this.engine && this.bindings.size === 0) {
      try { await stat(join(this.options.directory, 'engine-profile')); this.registryReadable = false; this.warning = 'Original engine data exists without its confirmed registry. It was retained; repair the original identity record before creating a Browser.' }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') { this.registryReadable = false; this.warning = 'Original engine storage could not be observed. Existing data was retained; no engine is launched.' } }
    }
    if (this.engine) await this.reobserveOriginalEngine()
  }
  /** Reobserve only this owner's original native endpoint file. Never spawn or claim an unbound page. */
  private async originalEndpoint(profileDirectory: string): Promise<string | undefined> {
    if (profileDirectory !== join(this.options.directory, 'engine-profile')) throw new Error('The saved native endpoint directory does not belong to this original Browser host.')
    try {
      const [port, path] = (await readFile(join(profileDirectory, 'DevToolsActivePort'), 'utf8')).trim().split('\n')
      const number = Number(port)
      if (Number.isInteger(number) && number > 0 && number <= 65535 && path && /^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(path)) return `ws://127.0.0.1:${number}${path}`
      return undefined
    } catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw cause }
  }
  private async reobserveOriginalEngine(): Promise<Browser | null> {
    if (this.browser) return this.browser
    if (this.reobserving) return await this.reobserving
    if (!this.engine || this.launch || !this.registryReadable) return null
    const original = this.engine
    this.reobserving = (async () => {
      try {
        if (original.profileDirectory !== join(this.options.directory, 'engine-profile')) throw new Error('Original native engine directory is outside this Browser host.')
        const endpoint = original.endpoint ?? await this.originalEndpoint(original.profileDirectory)
        if (!endpoint) { this.warning = 'The original engine has not published a confirmed endpoint. Its intent, Browser IDs and data remain; browser targets reobserves this same connection without launching or replaying create.'; return null }
        this.engine = { ...original, endpoint }
        const browser = await this.connect(endpoint)
        this.warning = undefined
        return browser
      } catch {
        const partial = this.browser; this.browser = null
        await partial?.disconnect().catch(() => {})
        for (const binding of this.bindings.values()) if (binding.status !== 'closed') {
          binding.status = binding.targetId && binding.navigationId ? 'disconnected' : 'unavailable'; binding.connection = null
          binding.warning = 'The original native connection is unconfirmed. Reobserve browser targets; no substitute or program replay is used.'
        }
        this.warning = 'The original native engine connection is unavailable. Browser IDs and input remain; browser targets retries only this original connection.'
        return null
      }
    })()
    try { return await this.reobserving } finally { this.reobserving = null }
  }
  private registryPath(): string { return join(this.options.directory, 'browser-targets.json') }
  private async persist(): Promise<void> {
    if (!this.registryReadable) throw new Error('The original Browser registry could not be read. Its bytes are retained; no empty replacement is written.')
    const state = { version: 1, engine: this.engine, targets: [...this.bindings.values()].map(({ workspaceId: _, connection: __, ...saved }) => saved) }
    const bytes = JSON.stringify(registrySchema.parse(state)) + '\n'
    const save = this.saveTail.catch(() => {}).then(() => durableWriteFile(this.registryPath(), bytes))
    this.saveTail = save
    try { await save; this.retentionWarning = undefined } catch (cause) { this.retentionWarning = 'Original Browser registry retention failed. Native pages remain; inspect the original host storage before another lifecycle action.'; throw cause }
  }
  private async connect(endpoint: string): Promise<Browser> {
    const browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null, protocolTimeout: 15_000 })
    this.browser = browser
    this.browserSession = await browser.target().createCDPSession()
    await this.browserSession.send('Target.setDiscoverTargets', { discover: true })
    browser.on('targetdestroyed', target => {
      const binding = this.targetBindings.get(target)
      if (!binding) return
      binding.status = 'closed'; binding.connection = null; this.nativeTargets.delete(binding.id); this.monitors.delete(binding.id); this.targetBindings.delete(target)
      for (const listener of this.availability.get(binding.id) ?? []) listener()
      void this.persist().catch(() => {})
    })
    browser.on('disconnected', () => {
      if (this.browser !== browser || this.stopped) return
      this.browser = null; this.browserSession = null
      for (const binding of this.bindings.values()) if (binding.status !== 'closed') {
        binding.status = 'disconnected'; binding.connection = null; binding.warning = 'The original native engine disconnected. Browser identity and input are retained; no command is replayed.'
        for (const listener of this.availability.get(binding.id) ?? []) listener()
      }
      void this.persist().catch(() => {})
    })
    const targets = new Map<string, Target>()
    for (const target of browser.targets()) if (target.type() === 'page') {
      const session = await target.createCDPSession()
      try { const { targetInfo } = await session.send('Target.getTargetInfo'); targets.set(targetInfo.targetId, target) } finally { await session.detach() }
    }
    for (const binding of this.bindings.values()) if (binding.status !== 'closed') {
      if (!binding.targetId) { binding.status = 'unavailable'; binding.warning = 'The original native target ID was never confirmed. Inspect its original create operation; no page is adopted by URL or title.'; continue }
      const target = targets.get(binding.targetId)
      if (target) await this.bind(binding, target)
      else { binding.status = 'unavailable'; binding.warning = 'The original target was not observed in its engine. No replacement is selected.' }
    }
    await this.persist().catch(() => {})
    return browser
  }
  private async bind(binding: Binding, target: Target): Promise<void> {
    const session = await target.createCDPSession(), browser = this.browser
    const { targetInfo } = await session.send('Target.getTargetInfo')
    if (targetInfo.targetId !== binding.targetId || targetInfo.type !== 'page') { await session.detach(); throw new Error('The native target identity does not match its original Browser.') }
    this.nativeTargets.set(binding.id, target); this.targetBindings.set(target, binding); this.monitors.set(binding.id, session)
    const notify = (method: string, params: unknown, mainDocumentNavigation = false) => { for (const fn of this.events.get(binding.id) ?? []) fn({ method, params, navigationId: binding.navigationId, mainDocumentNavigation }) }
    session.on('Page.frameNavigated', params => {
      const main = !params.frame.parentId
      if (main) { binding.navigationId = params.frame.loaderId; binding.url = params.frame.url; delete binding.ledgerNavigationId; void this.persist().catch(() => {}) }
      notify('Page.frameNavigated', params, main)
    })
    session.on('Page.navigatedWithinDocument', params => { binding.url = params.url; notify('Page.navigatedWithinDocument', params); void this.persist().catch(() => {}) })
    session.on('Page.loadEventFired', params => notify('Page.loadEventFired', params))
    await session.send('Page.enable')
    const { frameTree } = await session.send('Page.getFrameTree')
    binding.navigationId = frameTree.frame.loaderId; binding.url = frameTree.frame.url
    const value = await session.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true })
    binding.title = typeof value.result.value === 'string' ? value.result.value : ''
    binding.status = 'ready'; binding.connection = { id: browser!.wsEndpoint() }; delete binding.warning
    for (const listener of this.availability.get(binding.id) ?? []) listener()
  }
  private async engineForCreate(): Promise<Browser> {
    if (this.browser) return this.browser
    if (this.launch) return await this.launch
    if (this.engine) { const original = await this.reobserveOriginalEngine(); if (original) return original }
    if (this.engine) throw new Error('The original engine launch or connection is unconfirmed; it will not be replaced or replayed.')
    this.launch = (async () => {
      const profileDirectory = join(this.options.directory, 'engine-profile')
      this.engine = { profileDirectory }; await this.persist()
      await mkdir(profileDirectory, { recursive: true, mode: 0o700 })
      const args = await puppeteer.defaultArgs({ headless: true, userDataDir: profileDirectory })
      const processHandle = spawn(this.options.executablePath, [...args, '--remote-debugging-port=0'], { detached: true, stdio: 'ignore' })
      const spawnResult = new Promise<void>((resolve, reject) => { processHandle.once('spawn', resolve); processHandle.once('error', reject) })
      await spawnResult; processHandle.unref()
      // This file comes from the launched engine in this exact private directory. A PID is never a Browser receipt.
      const deadline = Date.now() + 30_000
      let endpoint: string | undefined
      while (Date.now() < deadline) {
        try { endpoint = await this.originalEndpoint(profileDirectory); if (endpoint) break }
        catch { /* Observation remains unknown; this launch is not repeated. */ }
        await delay(50)
      }
      if (!endpoint) throw new Error('The original native engine launch has no confirmed endpoint. Inspect its original operation; it was not launched again.')
      this.engine = { profileDirectory, endpoint }; await this.persist()
      return await this.connect(endpoint)
    })()
    try { return await this.launch } finally { this.launch = null }
  }
  async targets(): Promise<AgentMuxBrowserTargetsResult> {
    await this.ready()
    if (this.engine && !this.browser) await this.reobserveOriginalEngine()
    const warning = [this.warning, this.retentionWarning].filter(Boolean).join(' ')
    return { coverage: warning ? 'partial' : 'complete', ...(warning ? { warning } : {}), targets: [...this.bindings.values()].map(binding => this.publicTarget(binding)) }
  }

  private publicTarget(binding: Binding): AgentMuxBrowserTarget {
    return { id: binding.id, workspaceId: null, source: 'standalone', status: binding.status, ...(binding.navigationId ? { navigationId: binding.navigationId } : {}),
      dialogTypes: ['alert', 'confirm', 'prompt', 'beforeunload'],
      url: binding.url, title: binding.title, capabilities: binding.status === 'ready' ? BROWSER_PAGE_CAPABILITY_NAMES.filter(name => !['setViewport','download','readDownload','uploadFiles','readResult'].includes(name)) : [],
      control: { owner: 'unknown', activeOperationId: null, revision: 0, inputIsolation: 'unsupported', agent: null }, ...(binding.warning ? { warning: binding.warning } : {}) }
  }
  private async startLifecycle(operationId: string, browserId: string, intent: AgentMuxBrowserLifecycleIntent): Promise<void> {
    if (await this.journal.get(operationId)) throw browserOperationAlreadyExistsError()
    await this.journal.start({ id: operationId, browserId, operator: { id: 'host:standalone', name: 'Browser host' }, summary: `Preparing Browser ${intent.kind}`, url: intent.kind === 'create' ? intent.url : this.require(browserId).url, lifecycleIntent: intent })
    if (this.journal.getPersistenceWarning()) throw new Error('Lifecycle intent could not be retained. No native lifecycle command was sent; inspect the original operation and storage.')
  }
  async create(operationId: string, url: string): Promise<Extract<AgentMuxControlResult, { operation: 'browser.create' }>> {
    await this.ready()
    const existing = await this.journal.get(operationId)
    if (existing) throw browserOperationAlreadyExistsError()
    if (!this.registryReadable) throw new Error(this.warning ?? 'The original Browser registry is unavailable; no target is replaced.')
    const browserId = mintObjectId(), intent: AgentMuxBrowserLifecycleIntent = { kind: 'create', url: redactUrl(url) }
    await this.startLifecycle(operationId, browserId, intent)
    const binding: Binding = { id: browserId, targetId: null, workspaceId: null, connection: null, navigationId: '', url: 'about:blank', title: '', status: 'unavailable' }
    this.bindings.set(browserId, binding)
    let receipt: AgentMuxBrowserLifecycleReceipt
    try {
      await this.persist()
      const browser = await this.engineForCreate()
      const page = await browser.newPage()
      const native = page.target(), session = await native.createCDPSession()
      try { binding.targetId = (await session.send('Target.getTargetInfo')).targetInfo.targetId } finally { await session.detach() }
      await this.persist(); await this.bind(binding, native)
      if (url !== 'about:blank') await page.goto(url, { waitUntil: 'load', timeout: 30_000 })
      binding.title = await page.title()
      await this.persist()
      receipt = { operationId, browserId, intent, status: 'created' }
    } catch (cause) {
      receipt = { operationId, browserId, intent, status: 'unknown', message: `Browser creation could not be confirmed. Inspect this original operation and Browser; do not repeat it. ${cause instanceof Error ? cause.message : String(cause)}` }
      if (receipt.message) binding.warning = receipt.message
      await this.persist().catch(() => {})
    }
    if (!await this.journal.recordLifecycle(operationId, receipt)) receipt = { ...receipt, status: 'unknown', message: 'The native result is retained in this process, but its durable receipt is unconfirmed. Inspect the original operation; do not repeat it.' }
    return { operation: 'browser.create', receipt, ...(binding.status === 'ready' ? { target: this.publicTarget(binding) } : {}) }
  }
  async close(operationId: string, id: string, navigationId: string): Promise<Extract<AgentMuxControlResult, { operation: 'browser.close' }>> {
    await this.ready()
    if (await this.journal.get(operationId)) throw browserOperationAlreadyExistsError()
    const binding = this.require(id), intent: AgentMuxBrowserLifecycleIntent = { kind: 'close', navigationId }
    if (binding.status !== 'ready' || binding.navigationId !== navigationId || !this.browserSession || !binding.targetId) throw new Error('The original Browser document is not available for this close. No other target is selected.')
    await this.startLifecycle(operationId, id, intent)
    const session = this.monitors.get(id)!, browserSession = this.browserSession, targetId = binding.targetId
    let status: 'closed' | 'kept' | 'unknown' = 'unknown'
    let settle!: (status: 'closed' | 'kept' | 'unknown') => void
    const result = new Promise<'closed' | 'kept' | 'unknown'>(resolve => { settle = resolve })
    const destroyed = (params: { targetId: string }) => { if (params.targetId === targetId) settle('closed') }
    const dialog = (params: { type: string }) => {
      if (params.type === 'beforeunload') void session.send('Page.handleJavaScriptDialog', { accept: false }).then(() => settle('kept'), () => settle('unknown'))
    }
    browserSession.on('Target.targetDestroyed', destroyed); session.on('Page.javascriptDialogOpening', dialog)
    const timeout = setTimeout(() => settle('unknown'), 10_000)
    try {
      if (binding.navigationId !== navigationId || this.browserSession !== browserSession) { settle('unknown') }
      else {
      const command = session.send('Page.close').catch(() => { settle('unknown') })
      status = await result
      // Command acknowledgement alone is never a close receipt, nor does a missing ACK override the exact targetDestroyed fact.
      void command
      }
    } finally { clearTimeout(timeout); browserSession.off('Target.targetDestroyed', destroyed); session.off('Page.javascriptDialogOpening', dialog) }
    if (status === 'closed') { binding.status = 'closed'; binding.connection = null; this.nativeTargets.delete(id); this.monitors.delete(id) }
    await this.persist().catch(() => { status = 'unknown' })
    const receipt: AgentMuxBrowserLifecycleReceipt = { operationId, browserId: id, intent, status,
      ...(status === 'kept' ? { message: 'The original page asked before leaving. It was kept with its input; only a person can approve leaving.' } : status === 'unknown' ? { message: 'Closing the original Browser is unconfirmed. Its identity and operation are retained; inspect them and do not repeat.' } : {}) }
    const retained = await this.journal.recordLifecycle(operationId, receipt)
    return { operation: 'browser.close', receipt: retained ? receipt : { ...receipt, status: 'unknown', message: 'The native close result was observed, but its durable receipt is unconfirmed. Retain this Browser and operation identity; inspect the original result without replaying close.' } }
  }
  async execute(request: AgentMuxControlRequest): Promise<AgentMuxControlResult> {
    await this.ready()
    switch (request.operation) {
      case 'browser.create': return await this.create(request.operationId, request.url)
      case 'browser.close': return await this.close(request.operationId, request.browserId, request.navigationId)
      case 'browser.targets': return { operation: request.operation, ...await this.targets(), ...(request.workspaceId ? { targets: [] } : {}) }
      case 'browser.run': if (!this.browser && this.engine) await this.reobserveOriginalEngine(); return { operation: request.operation, ...await this.programs.runScript(request.browserId, request.code, undefined, request.operationId) }
      case 'browser.stop': return { operation: request.operation, runOperation: await this.programs.stopOperationById(request.operationId) ?? await this.journal.get(request.operationId) }
      case 'browser.history': return { operation: request.operation, operations: await this.journal.list(request.browserId) }
      case 'browser.operation': return request.resultRead
        ? { operation: request.operation, ...await readBrowserOperationResult(request.operationId, request.resultRead, {
          getOperation: id => this.journal.get(id),
          readStepResult: (id, sequence, options) => this.programs.readStepResult(id, sequence, options)
        }) }
        : { operation: request.operation, runOperation: await this.journal.get(request.operationId) }
      default: throw Object.assign(new Error('This operation has no standalone Browser host capability. Existing Browser and Agent capabilities remain available.'), { code: 'BROWSER_HOST_CAPABILITY_UNAVAILABLE' })
    }
  }
  private async disconnect(): Promise<void> { const browser = this.browser; this.browser = null; await browser?.disconnect() }
  async stop(): Promise<void> {
    this.stopped = true
    await this.programs.dispose(); await this.persist().catch(() => {}); await this.lock?.close(); this.lock = null
  }
}
function redactUrl(value: string): string { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.href }
