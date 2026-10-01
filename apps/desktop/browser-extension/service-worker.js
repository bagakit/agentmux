import { EXTERNAL_BROWSER_PROTOCOL, MAX_BRIDGE_BYTES, isShareUrl, isTabScopedCommand } from './protocol.js'

/** Authority stays with the extension popup's explicit share, never a CDP caller's tab argument. */
export class SharedTabWorker {
  constructor(api, Socket) {
    this.api = api; this.Socket = Socket
    this.grants = new Map(); this.socket = null; this.connectionId = null
    this.instanceId = ''; this.generation = 0; this.completed = new Set()
    this.shareWaiters = new Map(); this.attachOwners = new Map()
    this.requestTails = new Map()
    this.ready = this.load()
  }
  async load() {
    const state = await this.api.storage.session.get(['instanceId', 'grants'])
    this.instanceId = state.instanceId || crypto.randomUUID()
    for (const grant of state.grants || []) {
      if (!Number.isInteger(grant.tabId) || typeof grant.grantId !== 'string') continue
      try {
        const tab = await this.api.tabs.get(grant.tabId)
        if (isShareUrl(tab.url)) this.grants.set(grant.tabId, { ...grant, attached: false, frames: new Map() })
      } catch { /* A closed tab is no longer shared. No replacement is chosen. */ }
    }
    await this.persist()
  }
  async persist() {
    await this.api.storage.session.set({ instanceId: this.instanceId,
      grants: [...this.grants.values()].map(({ frames, attached, ...grant }) => grant) })
  }
  start() {
    this.api.runtime.onMessage.addListener((message, sender, reply) => {
      if (sender.tab || sender.url !== this.api.runtime.getURL('popup.html')) return false
      void this.popup(message).then(value => reply({ ok: true, value }), error => reply({ ok: false, error: error.message }))
      return true
    })
    this.api.tabs.onRemoved.addListener(tabId => { if (this.grants.has(tabId)) void this.revoke(tabId, 'closed') })
    this.api.tabs.onUpdated.addListener((tabId, change) => {
      const grant = this.grants.get(tabId)
      if (!grant) return
      if (change.url && !isShareUrl(change.url)) { void this.revoke(tabId, 'unavailable'); return }
      if (typeof change.title === 'string') {
        grant.title = change.title.slice(0, 512)
        this.send({ type: 'metadata', ...this.describe(grant) })
      }
    })
    this.api.debugger.onDetach.addListener(source => {
      const grant = this.grants.get(source.tabId)
      if (grant?.attached) void this.revoke(source.tabId, 'detached')
    })
    this.api.debugger.onEvent.addListener((source, method, params) => this.event(source, method, params))
  }
  async popup(message) {
    await this.ready
    if (message.type === 'status') return { connected: this.connectionId !== null,
      tabs: [...this.grants.values()].map(({ tabId, title, bindingId }) => ({ tabId, title, bindingId })) }
    if (message.type === 'connect') return await this.connect(message.link)
    if (message.type === 'unshare') { await this.revoke(message.tabId, 'revoked'); return {} }
    if (message.type !== 'share' || !this.connectionId || !Number.isInteger(message.tabId)) throw new Error('Connect before sharing a selected tab.')
    const [selected] = await this.api.tabs.query({ active: true, currentWindow: true })
    if (selected?.id !== message.tabId) throw new Error('The selected tab changed. Choose the original tab and share it explicitly.')
    const tab = await this.api.tabs.get(message.tabId)
    if (!isShareUrl(tab.url)) throw new Error('Share a normal HTTPS or local HTTP page. Browser-restricted pages remain unavailable.')
    const current = this.grants.get(tab.id)
    if (current) return { bindingId: current.bindingId }
    const grant = { tabId: tab.id, grantId: crypto.randomUUID(), navigationId: crypto.randomUUID(),
      url: tab.url, title: tab.title || '', attached: false, frames: new Map() }
    this.grants.set(tab.id, grant)
    await this.persist()
    if (this.grants.get(tab.id) !== grant) throw new Error('The selected tab is no longer shared.')
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.shareWaiters.delete(grant.grantId)
        void this.revoke(grant.tabId, 'revoked')
        reject(new Error('AgentMux did not confirm this shared tab. Check the connection before sharing again.'))
      }, 10_000)
      this.shareWaiters.set(grant.grantId, { resolve, reject, timer })
      this.send({ type: 'share', ...this.describe(grant) })
    })
  }
  describe(grant) {
    return { tabId: grant.tabId, grantId: grant.grantId, navigationId: grant.navigationId,
      url: grant.url, title: grant.title }
  }
  async connect(link) {
    const url = new URL(link)
    const token = url.hash.slice(1)
    if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || url.pathname !== '/shared-tab' ||
      !url.port || !/^[a-f0-9]{64}$/.test(token) || url.username || url.password || url.search) throw new Error('Paste the connection link from AgentMux Browser settings.')
    url.hash = ''
    this.disconnect('A new connection replaced the old transport.')
    const generation = ++this.generation
    const socket = new this.Socket(url.href)
    this.socket = socket
    return await new Promise((resolve, reject) => {
      let settled = false
      const finish = error => {
        if (settled) return
        settled = true; clearTimeout(timeout)
        if (error) reject(error); else resolve({})
      }
      const timeout = setTimeout(() => { socket.close(); finish(new Error('AgentMux did not confirm this connection. Original tabs remain available.')) }, 10_000)
      socket.addEventListener('open', () => {
        if (this.socket !== socket || generation !== this.generation) return
        socket.send(JSON.stringify({ type: 'hello', protocol: EXTERNAL_BROWSER_PROTOCOL, token,
          instanceId: this.instanceId, grants: [...this.grants.values()].map(grant => this.describe(grant)) }))
      })
      socket.addEventListener('message', event => {
        if (this.socket !== socket || generation !== this.generation || typeof event.data !== 'string' || event.data.length > MAX_BRIDGE_BYTES) return
        let message; try { message = JSON.parse(event.data) } catch { socket.close(); return }
        if (message.type === 'welcome' && typeof message.connectionId === 'string') {
          this.connectionId = message.connectionId
          for (const row of message.bindings || []) this.bound(row)
          for (const grantId of message.rejectedGrants || []) {
            const grant = [...this.grants.values()].find(item => item.grantId === grantId)
            if (grant) void this.revoke(grant.tabId, 'revoked')
          }
          finish(); return
        }
        if (message.connectionId !== this.connectionId || !this.connectionId) return
        if (message.type === 'bound') this.bound(message)
        else if (message.type === 'rejected') {
          const waiter = this.shareWaiters.get(message.grantId)
          if (waiter) { this.shareWaiters.delete(message.grantId); clearTimeout(waiter.timer); waiter.reject(new Error(message.reason || 'The original tab could not be shared.')) }
          const grant = [...this.grants.values()].find(item => item.grantId === message.grantId)
          if (grant) void this.revoke(grant.tabId, 'revoked')
        }
        else if (message.type === 'request') this.enqueueRequest(message, socket, generation)
      })
      socket.addEventListener('close', () => {
        if (this.socket === socket) this.disconnect('AgentMux disconnected. Sent actions are not replayed.')
        finish(new Error('AgentMux disconnected. Check Browser settings before reconnecting.'))
      })
      socket.addEventListener('error', () => finish(new Error('Could not connect to AgentMux. Original tabs remain available.')))
    })
  }
  bound(row) {
    const grant = this.grants.get(row.tabId)
    if (grant?.grantId === row.grantId && typeof row.bindingId === 'string') {
      grant.bindingId = row.bindingId
      const waiter = this.shareWaiters.get(row.grantId)
      if (waiter) { this.shareWaiters.delete(row.grantId); clearTimeout(waiter.timer); waiter.resolve({ bindingId: row.bindingId }) }
    }
  }
  send(message) {
    if (this.socket?.readyState === 1 && this.connectionId) this.socket.send(JSON.stringify({ ...message, connectionId: this.connectionId }))
  }
  disconnect(_reason) {
    const socket = this.socket
    this.socket = null; this.connectionId = null; this.generation++
    socket?.close()
    for (const waiter of this.shareWaiters.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('AgentMux disconnected before sharing was confirmed.')) }
    this.shareWaiters.clear()
    for (const grant of this.grants.values()) {
      const lease = this.attachOwners.get(grant.tabId)
      if (lease?.grant === grant) lease.cancelled = true
      const attached = grant.attached
      grant.attached = false; grant.frames.clear()
      if (attached) void this.releaseAttach(grant)
    }
  }
  async revoke(tabId, reason) {
    const grant = this.grants.get(tabId)
    if (!grant) return
    this.grants.delete(tabId) // Revoke before the first await, including a racing debugger attach.
    const lease = this.attachOwners.get(tabId)
    if (lease?.grant === grant) lease.cancelled = true
    const waiter = this.shareWaiters.get(grant.grantId)
    if (waiter) { this.shareWaiters.delete(grant.grantId); clearTimeout(waiter.timer); waiter.reject(new Error('The original tab stopped sharing.')) }
    this.send({ type: 'revoked', tabId, grantId: grant.grantId, reason })
    if (grant.attached) {
      grant.attached = false; grant.frames.clear()
      await this.releaseAttach(grant)
    }
    await this.persist()
  }
  async releaseAttach(grant) {
    const lease = this.attachOwners.get(grant.tabId)
    if (lease?.grant !== grant) return
    lease.cancelled = true
    try { await this.api.debugger.detach({ tabId: grant.tabId }) } catch { /* Closed/detached is already unavailable. */ }
    if (this.attachOwners.get(grant.tabId) === lease) this.attachOwners.delete(grant.tabId)
  }
  enqueueRequest(message, socket, generation) {
    if (message.action === 'detach') { void this.request(message, socket, generation); return }
    const previous = this.requestTails.get(message.tabId) || Promise.resolve()
    const next = previous.then(() => this.request(message, socket, generation))
    this.requestTails.set(message.tabId, next)
    void next.finally(() => { if (this.requestTails.get(message.tabId) === next) this.requestTails.delete(message.tabId) })
  }
  event(source, method, params) {
    const grant = this.grants.get(source.tabId)
    if (!grant?.attached || (source.sessionId && !grant.frames.has(source.sessionId))) return
    if (method === 'Target.attachedToTarget') {
      if (params.targetInfo?.type !== 'iframe' || typeof params.sessionId !== 'string') return
      grant.frames.set(params.sessionId, source.sessionId || null)
    }
    if (method === 'Target.detachedFromTarget') {
      const remove = new Set([params.sessionId])
      for (const [id, parent] of grant.frames) if (remove.has(parent)) remove.add(id)
      for (const id of remove) grant.frames.delete(id)
    }
    const mainDocumentNavigation = (method === 'Page.frameNavigated' && !source.sessionId && !params.frame?.parentId) ||
      (method === 'Page.navigatedWithinDocument' && !source.sessionId && params.frameId === grant.rootFrameId)
    if (mainDocumentNavigation) {
      grant.navigationId = params.frame?.loaderId || crypto.randomUUID()
      grant.url = params.frame?.url || params.url || grant.url
      if (!isShareUrl(grant.url)) { void this.revoke(grant.tabId, 'unavailable'); return }
      grant.frames.clear()
    }
    this.send({ type: 'event', tabId: grant.tabId, grantId: grant.grantId, navigationId: grant.navigationId,
      ...(source.sessionId ? { sessionId: source.sessionId } : {}), mainDocumentNavigation, method, params, url: grant.url, title: grant.title })
  }
  async request(message, socket, generation) {
    const grant = this.grants.get(message.tabId)
    let sent = false
    const current = allowNavigation => {
      if (this.socket !== socket || generation !== this.generation || message.connectionId !== this.connectionId ||
        !grant || this.grants.get(message.tabId) !== grant || grant.grantId !== message.grantId ||
        (!allowNavigation && message.navigationId !== grant.navigationId)) throw new Error('The original shared tab or document changed. No replacement is selected.')
      if (message.sessionId && !grant.frames.has(message.sessionId)) throw new Error('This child session does not belong to the shared tab.')
    }
    try {
      if (typeof message.requestId !== 'string' || this.completed.has(message.requestId) ||
        typeof message.operationId !== 'string' || typeof message.callerId !== 'string') throw new Error('Invalid or duplicate request identity.')
      this.completed.add(message.requestId)
      if (this.completed.size > 1024) this.completed.delete(this.completed.values().next().value)
      current(message.action === 'detach')
      const tab = await this.api.tabs.get(grant.tabId)
      current(message.action === 'detach')
      if (!isShareUrl(tab.url)) throw new Error('The original tab is a browser-restricted page.')
      const target = message.sessionId ? { tabId: grant.tabId, sessionId: message.sessionId } : { tabId: grant.tabId }
      let value
      if (message.action === 'attach') {
        if (grant.attached || this.attachOwners.has(grant.tabId)) throw new Error('Another operation is attached to or releasing this shared tab.')
        const lease = { grant, generation, operationId: message.operationId, callerId: message.callerId, cancelled: false }
        this.attachOwners.set(grant.tabId, lease)
        sent = true
        try { await this.api.debugger.attach(target, '1.3'); current(false); if (lease.cancelled) throw new Error('The original operation stopped during debugger attachment.') }
        catch (error) { await this.releaseAttach(grant); throw error }
        grant.attached = true
        await this.api.debugger.sendCommand(target, 'Page.enable')
        current(true)
        if (this.attachOwners.get(grant.tabId) !== lease || lease.cancelled || !grant.attached) throw new Error('The original operation stopped during debugger preparation.')
        const tree = await this.api.debugger.sendCommand(target, 'Page.getFrameTree')
        current(true)
        if (this.attachOwners.get(grant.tabId) !== lease || lease.cancelled || !grant.attached) throw new Error('The original operation stopped during debugger preparation.')
        grant.navigationId = tree.frameTree?.frame?.loaderId || grant.navigationId
        grant.url = tree.frameTree?.frame?.url || tab.url
        grant.rootFrameId = tree.frameTree?.frame?.id
        grant.title = typeof tab.title === 'string' ? tab.title.slice(0, 512) : grant.title
        value = this.describe(grant)
      } else if (message.action === 'detach') {
        const lease = this.attachOwners.get(grant.tabId)
        if (lease && (lease.grant !== grant || lease.generation !== generation || lease.operationId !== message.operationId || lease.callerId !== message.callerId)) throw new Error('The original operation no longer owns this debugger attachment.')
        if (lease) lease.cancelled = true
        if (grant.attached) {
          grant.attached = false; grant.frames.clear()
          await this.releaseAttach(grant)
        }
        value = {}
      } else if (message.action === 'command') {
        const lease = this.attachOwners.get(grant.tabId)
        if (lease?.grant !== grant || lease.cancelled || lease.generation !== generation || lease.operationId !== message.operationId || lease.callerId !== message.callerId) throw new Error('The original operation no longer owns this debugger attachment.')
        if (!grant.attached || !isTabScopedCommand(message.method, message.params)) throw new Error('This command is outside the shared-tab capability.')
        current(false); sent = true
        value = await this.api.debugger.sendCommand(target, message.method, message.params || {})
        current(message.method === 'Page.navigate')
      } else throw new Error('Unknown shared-tab action.')
      current(message.action === 'attach' || message.action === 'detach' || message.method === 'Page.navigate')
      this.reply(message, { value, navigationId: grant.navigationId }, socket, generation)
    } catch (error) {
      let uncertain = false
      try { current(message.action === 'attach' || message.action === 'detach' || message.method === 'Page.navigate') }
      catch { uncertain = sent }
      this.reply(message, { error: error.message, sent, uncertain }, socket, generation)
    }
  }
  reply(message, payload, socket, generation) {
    if (this.socket !== socket || generation !== this.generation || message.connectionId !== this.connectionId) return
    this.send({ type: 'response', requestId: message.requestId, tabId: message.tabId, grantId: message.grantId,
      operationId: message.operationId, callerId: message.callerId,
      ...(message.sessionId ? { sessionId: message.sessionId } : {}),
      navigationId: this.grants.get(message.tabId)?.navigationId ?? message.navigationId, ...payload })
  }
}

export const worker = new SharedTabWorker(chrome, WebSocket)
worker.start()
