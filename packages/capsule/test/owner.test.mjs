import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, request } from 'node:http'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { NodeCapsuleOwner } from '../dist/node.js'
import { parseCapsuleParams, parseCapsuleResult } from '../dist/index.js'

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'amux-capsule-test-'))
  const source = join(directory, 'source')
  await mkdir(source)
  await writeFile(
    join(source, 'index.html'),
    '<!doctype html><html><head></head><body>original</body></html>',
  )
  await writeFile(join(source, 'app.js'), 'window.page="original"')
  const stateDirectory = join(directory, 'state')
  const owner = await NodeCapsuleOwner.open({ stateDirectory, ...options })
  t.after(async () => {
    await owner.close()
    await rm(directory, { recursive: true, force: true })
  })
  return { owner, source, stateDirectory, directory }
}
async function body(url, init) {
  const response = await fetch(url, init)
  assert.equal(response.status, 200)
  return response.text()
}
function rawHttp(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, headers }, (res) => {
      let data = ''
      res.on('data', (part) => {
        data += part
      })
      res.on('end', () => resolve({ status: res.statusCode, body: data }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('managed and path content combine with isolated and injected modes using actual HTTP', async (t) => {
  const injection = { html: async () => '<meta name="capsule-injected" content="yes">' }
  const { owner, source } = await fixture(t, { injection })
  for (const storageMode of ['managed', 'path'])
    for (const mode of ['isolated', 'injected']) {
      const params = { operationId: `${storageMode}-${mode}`, sourcePath: source, storageMode, mode }
      const created = await owner.call('capsule.create', params)
      assert.equal(created.status, 'committed')
      const text = await body(created.endpoint.url)
      assert.equal(text.includes('capsule-injected'), mode === 'injected')
      assert.equal(await body(new URL('app.js', created.endpoint.url)), 'window.page="original"')
      assert.deepEqual(await owner.call('capsule.create', params), created)
      await assert.rejects(owner.call('capsule.create', { ...params, title: 'different' }), {
        code: 'CAPSULE_OPERATION_CONFLICT',
      })
      assert.equal(
        (await owner.call('capsule.operation.inspect', { operationId: params.operationId })).operation.status,
        'committed',
      )
    }
  assert.equal((await owner.call('capsule.ls', {})).capsules.length, 4)
})

test('managed publication retains bytes after source removal; path failure preserves registration and other pages', async (t) => {
  const { owner, source } = await fixture(t)
  const managed = await owner.call('capsule.create', { operationId: 'managed', sourcePath: source })
  const path = await owner.call('capsule.create', {
    operationId: 'path',
    sourcePath: source,
    storageMode: 'path',
  })
  await rm(source, { recursive: true })
  assert.match(await body(managed.endpoint.url), /original/u)
  const missing = await owner.call('capsule.inspect', { capsuleId: path.record.capsuleId })
  assert.equal(missing.content.status, 'unavailable')
  assert.equal(missing.record.capsuleId, path.record.capsuleId)
  assert.equal(missing.endpoint.port, path.record.port)
  assert.equal((await owner.call('capsule.ls', {})).capsules.length, 2)
  const response = await fetch(path.endpoint.url)
  assert.equal(response.status, 404)
})

test('prepared updates and config CAS retain original content, identity, port and roots', async (t) => {
  const { owner, source, directory } = await fixture(t)
  const created = await owner.call('capsule.create', { operationId: 'publish', sourcePath: source })
  const config = (await owner.call('capsule.config.inspect', {})).config
  const nextRoot = join(directory, 'new-managed-root')
  await owner.call('capsule.config.update', {
    operationId: 'config',
    expectedRevision: config.revision,
    changes: { contentRoot: nextRoot, defaultMode: 'injected' },
  })
  await assert.rejects(
    owner.call('capsule.config.update', {
      operationId: 'stale-config',
      expectedRevision: config.revision,
      changes: { defaultTheme: 'none' },
    }),
    { code: 'CAPSULE_REVISION_CONFLICT' },
  )
  const original = await owner.call('capsule.inspect', { capsuleId: created.record.capsuleId })
  assert.equal(original.record.contentRoot, created.record.contentRoot)
  assert.equal(original.record.mode, 'isolated')
  await writeFile(join(source, 'index.html'), '<h1>second revision</h1>')
  const updated = await owner.call('capsule.update', {
    operationId: 'update',
    capsuleId: created.record.capsuleId,
    expectedRevision: 1,
    changes: { sourcePath: source, title: 'Changed' },
  })
  assert.equal(updated.record.revision, 2)
  assert.equal(updated.record.capsuleId, created.record.capsuleId)
  assert.equal(updated.endpoint.port, created.endpoint.port)
  assert.match(await body(created.endpoint.url), /second revision/u)
  await assert.rejects(
    owner.call('capsule.update', {
      operationId: 'stale',
      capsuleId: created.record.capsuleId,
      expectedRevision: 1,
      changes: { title: 'Lost update' },
    }),
    { code: 'CAPSULE_REVISION_CONFLICT' },
  )
  await rm(join(source, 'index.html'))
  await assert.rejects(
    owner.call('capsule.update', {
      operationId: 'broken-source',
      capsuleId: created.record.capsuleId,
      expectedRevision: 2,
      changes: { sourcePath: source },
    }),
    { code: 'CAPSULE_CONTENT_UNAVAILABLE' },
  )
  assert.match(await body(created.endpoint.url), /second revision/u)
  assert.equal(
    (await owner.call('capsule.inspect', { capsuleId: created.record.capsuleId })).record.revision,
    2,
  )
  await writeFile(join(source, 'index.html'), 'third')
  const next = await owner.call('capsule.create', { operationId: 'new-defaults', sourcePath: source })
  assert.ok(next.record.contentRoot.startsWith((await realpath(nextRoot)) + '/'))
  assert.equal(next.record.mode, 'injected')
  assert.ok(next.issues.some((x) => x.code === 'CAPSULE_INJECTION_UNAVAILABLE'))
})

test('real process death restores original IDs, bytes, operations, drafts and exact origins', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'amux-capsule-process-'))
  const source = join(directory, 'source'),
    stateDirectory = join(directory, 'state')
  await mkdir(source)
  await writeFile(join(source, 'index.html'), 'cross-process durable')
  const children = []
  t.after(async () => {
    for (const child of children)
      if (child.exitCode === null && !child.killed) {
        child.kill('SIGKILL')
        await once(child, 'exit')
      }
    await rm(directory, { recursive: true, force: true })
  })
  async function worker() {
    const child = fork(new URL('./worker.mjs', import.meta.url), [], {
      env: { ...process.env, CAPSULE_TEST_STATE: stateDirectory },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    children.push(child)
    const [ready] = await once(child, 'message')
    assert.equal(ready.ready, true)
    let sequence = 0
    return {
      child,
      call(method, params) {
        const id = ++sequence
        return new Promise((resolve, reject) => {
          const listener = (message) => {
            if (message.id !== id) return
            child.off('message', listener)
            message.error
              ? reject(Object.assign(new Error(message.error.message), { code: message.error.code }))
              : resolve(message.result)
          }
          child.on('message', listener)
          child.send({ id, method, params })
        })
      },
    }
  }
  let first = await worker()
  const created = await first.call('capsule.create', {
    operationId: 'cross-create',
    sourcePath: source,
    target: { hostId: 'original-host', agentSessionId: 'original-agent' },
  })
  const interaction = (
    await first.call('capsule.interaction.request', {
      operationId: 'question',
      capsuleId: created.record.capsuleId,
      question: 'Approve the result?',
      draft: 'retained draft',
    })
  ).interaction
  const port = created.record.port
  assert.equal(await body(created.endpoint.url), 'cross-process durable')
  first.child.kill('SIGKILL')
  await once(first.child, 'exit')
  await rm(source, { recursive: true })
  const second = await worker()
  const recovered = await second.call('capsule.inspect', { capsuleId: created.record.capsuleId })
  assert.equal(recovered.record.port, port)
  assert.equal(recovered.endpoint.url, created.endpoint.url)
  assert.equal(await body(recovered.endpoint.url), 'cross-process durable')
  const original = (await second.call('capsule.operation.inspect', { operationId: 'cross-create' })).operation
  assert.equal(original.result.record.capsuleId, created.record.capsuleId)
  assert.deepEqual(
    (
      await second.call('capsule.interaction.inspect', {
        capsuleId: created.record.capsuleId,
        interactionId: interaction.interactionId,
      })
    ).interaction,
    interaction,
  )
  await second.call('close', {})
})

test('port conflict and corrupt manifest affect only the exact page and retry the same origin', async (t) => {
  const { owner, source, stateDirectory } = await fixture(t)
  const page = await owner.call('capsule.create', { operationId: 'one', sourcePath: source })
  const healthy = await owner.call('capsule.create', { operationId: 'two', sourcePath: source })
  await owner.close()
  const blocker = createServer((_req, res) => res.end('unrelated'))
  blocker.listen(page.record.port, '127.0.0.1')
  await once(blocker, 'listening')
  t.after(() => blocker.close())
  const next = await NodeCapsuleOwner.open({ stateDirectory })
  t.after(() => next.close())
  const conflict = await next.call('capsule.resolve', { capsuleId: page.record.capsuleId })
  assert.equal(conflict.endpoint.status, 'unavailable')
  assert.equal(conflict.endpoint.port, page.record.port)
  assert.equal(
    await body(healthy.endpoint.url),
    await body((await next.call('capsule.resolve', { capsuleId: healthy.record.capsuleId })).endpoint.url),
  )
  await new Promise((resolve, reject) => blocker.close((error) => (error ? reject(error) : resolve())))
  const repaired = await next.call('capsule.resolve', { capsuleId: page.record.capsuleId })
  assert.equal(repaired.endpoint.url, page.endpoint.url)
  const manifest = join(stateDirectory, 'records', `${page.record.capsuleId}.json`),
    previous = await readFile(manifest, 'utf8')
  await writeFile(manifest, '{broken')
  const list = await next.call('capsule.ls', {})
  assert.equal(list.capsules.length, 1)
  assert.equal(
    list.issues.some((x) => x.stage === 'registry'),
    true,
  )
  assert.match(await body(page.endpoint.url), /original/u)
  await writeFile(manifest, previous)
  assert.equal((await next.call('capsule.ls', {})).capsules.length, 2)
})

test('SPA fallback keeps missing assets honest; traversal, links, POST and foreign Host are rejected', async (t) => {
  const { owner, source, directory } = await fixture(t)
  await writeFile(join(directory, 'secret.txt'), 'private')
  const created = await owner.call('capsule.create', {
    operationId: 'spa',
    sourcePath: source,
    storageMode: 'path',
    routing: 'spa',
  })
  assert.match(
    await body(new URL('/route/nested', created.endpoint.url), { headers: { Accept: 'text/html' } }),
    /original/u,
  )
  assert.equal((await fetch(new URL('/missing.js', created.endpoint.url))).status, 404)
  assert.equal(
    (await fetch(created.endpoint.url, { method: 'POST', body: '{"author":"human"}' })).status,
    405,
  )
  assert.equal((await rawHttp(created.record.port, '/%2e%2e/secret.txt')).status, 400)
  assert.equal((await rawHttp(created.record.port, '/', { Host: 'hostile.example' })).status, 421)
  await symlink(join(directory, 'secret.txt'), join(source, 'linked.txt'))
  const linked = await fetch(new URL('linked.txt', created.endpoint.url))
  assert.equal(linked.status, 403)
  assert.notEqual(await linked.text(), 'private')
  await assert.rejects(owner.call('capsule.create', { operationId: 'unsafe-import', sourcePath: source }), {
    code: 'CAPSULE_SOURCE_UNSAFE',
  })
})

test('original operation identity and pending presentation are retained without replay', async (t) => {
  let calls = 0
  const { owner, source, stateDirectory } = await fixture(t, {
    presentation: {
      async open() {
        calls++
        throw new Error('lost response')
      },
    },
  })
  const created = await owner.call(
    'capsule.create',
    { operationId: 'creator', sourcePath: source },
    { caller: { hostId: 'host', agentSessionId: 'creator' } },
  )
  await assert.rejects(
    owner.call(
      'capsule.create',
      { operationId: 'creator', sourcePath: source },
      { caller: { hostId: 'host', agentSessionId: 'other' } },
    ),
    { code: 'CAPSULE_OPERATION_CONFLICT' },
  )
  const params = { operationId: 'open-once', capsuleId: created.record.capsuleId }
  await assert.rejects(owner.call('capsule.open', params), { code: 'CAPSULE_OPERATION_UNKNOWN' })
  assert.equal(
    (await owner.call('capsule.operation.inspect', { operationId: params.operationId })).operation.status,
    'pending',
  )
  await assert.rejects(owner.call('capsule.open', params), { code: 'CAPSULE_OPERATION_UNKNOWN' })
  assert.equal(calls, 1)
  assert.equal((await owner.call('capsule.operation.inspect', { operationId: 'unknown' })).operation, null)
  await owner.close()
  const recovered = await NodeCapsuleOwner.open({
    stateDirectory,
    presentation: {
      async open() {
        calls++
        throw new Error('must not replay')
      },
    },
  })
  t.after(() => recovered.close())
  await assert.rejects(recovered.call('capsule.open', params), { code: 'CAPSULE_OPERATION_UNKNOWN' })
  assert.equal(calls, 1)
})

test('durable interaction drafts retain original target; no page or caller string authenticates Human', async (t) => {
  const { owner, source } = await fixture(t)
  const page = await owner.call('capsule.create', {
    operationId: 'page',
    sourcePath: source,
    target: { hostId: 'host-original', agentSessionId: 'agent-original' },
  })
  const requested = await owner.call('capsule.interaction.request', {
    capsuleId: page.record.capsuleId,
    operationId: 'question',
    question: 'Choose?',
    draft: 'first',
  })
  const params = {
    capsuleId: page.record.capsuleId,
    interactionId: requested.interaction.interactionId,
    operationId: 'draft',
    expectedRevision: 1,
    draft: 'edited',
  }
  const edited = await owner.call('capsule.interaction.draft', params)
  assert.equal(edited.interaction.draft, 'edited')
  assert.deepEqual(edited.interaction.target, page.record.target)
  await assert.rejects(owner.call('capsule.interaction.draft', { ...params, operationId: 'stale-draft' }), {
    code: 'CAPSULE_REVISION_CONFLICT',
  })
  await assert.rejects(
    owner.call(
      'capsule.interaction.reply',
      {
        capsuleId: page.record.capsuleId,
        interactionId: requested.interaction.interactionId,
        operationId: 'reply',
        expectedRevision: 2,
        answer: 'yes',
      },
      { principal: { kind: 'user', id: 'declared-user' } },
    ),
    { code: 'CAPSULE_TRUSTED_REPLY_UNAVAILABLE' },
  )
  assert.equal(
    (await owner.call('capsule.interaction.ls', { capsuleId: page.record.capsuleId })).interactions[0].status,
    'pending',
  )
})

test('wire parsers reject unknown fields, malformed enums and forged result identity', async (t) => {
  const { owner, source } = await fixture(t)
  const created = await owner.call('capsule.create', { operationId: 'page', sourcePath: source })
  assert.throws(() =>
    parseCapsuleParams('capsule.create', { operationId: 'x', sourcePath: source, author: 'human' }),
  )
  assert.throws(() =>
    parseCapsuleParams('capsule.create', { operationId: 'x', sourcePath: source, mode: 'container' }),
  )
  assert.throws(() =>
    parseCapsuleParams('capsule.update', {
      operationId: 'x',
      capsuleId: created.record.capsuleId,
      expectedRevision: 1,
      changes: { entry: '../secret' },
    }),
  )
  assert.throws(() =>
    parseCapsuleResult('capsule.create', {
      ...created,
      endpoint: { ...created.endpoint, port: created.record.port + 1 },
    }),
  )
  assert.throws(() =>
    parseCapsuleResult('capsule.inspect', { ...created, operationId: undefined, status: undefined }),
  )
})

test('self-containing managed imports are rejected before creating a destination subtree', async (t) => {
  const { owner, source } = await fixture(t)
  const config = (await owner.call('capsule.config.inspect', {})).config
  await owner.call('capsule.config.update', {
    operationId: 'inside-source',
    expectedRevision: config.revision,
    changes: { contentRoot: join(source, 'managed') },
  })
  await assert.rejects(
    owner.call('capsule.create', { operationId: 'recursive-source', sourcePath: source }),
    { code: 'CAPSULE_SOURCE_CONTAINS_DESTINATION' },
  )
  assert.deepEqual((await readdir(source)).sort(), ['app.js', 'index.html'])
  assert.equal((await owner.call('capsule.ls', {})).capsules.length, 0)
})

test('explicit removal retains path sources, keeps managed content by default, and deletes only the pinned managed page', async (t) => {
  const { owner, source } = await fixture(t)
  for (const storageMode of ['managed', 'path']) {
    const created = await owner.call('capsule.create', {
      operationId: `${storageMode}-remove`,
      sourcePath: source,
      storageMode,
    })
    const removed = await owner.call('capsule.remove', {
      operationId: `${storageMode}-delete`,
      capsuleId: created.record.capsuleId,
      expectedRevision: 1,
      deleteContent: true,
    })
    assert.equal(removed.deletedContent, storageMode === 'managed')
    assert.match(await readFile(join(source, 'index.html'), 'utf8'), /original/u)
    assert.equal(
      (await owner.call('capsule.operation.inspect', { operationId: `${storageMode}-delete` })).operation
        .status,
      'committed',
    )
  }
  const keep = await owner.call('capsule.create', { operationId: 'keep-content', sourcePath: source })
  const removed = await owner.call('capsule.remove', {
    operationId: 'remove-registration',
    capsuleId: keep.record.capsuleId,
    expectedRevision: 1,
  })
  assert.equal(removed.deletedContent, false)
  assert.match(await readFile(join(keep.record.contentRoot, 'index.html'), 'utf8'), /original/u)
})

test('trusted principal participates in original operation identity; owner lease never replaces the healthy service', async (t) => {
  const { owner, source, stateDirectory } = await fixture(t)
  const params = { operationId: 'principal-create', sourcePath: source }
  const created = await owner.call('capsule.create', params, {
    principal: { kind: 'device', id: 'original-device' },
  })
  await assert.rejects(
    owner.call('capsule.create', params, { principal: { kind: 'device', id: 'other-device' } }),
    { code: 'CAPSULE_OPERATION_CONFLICT' },
  )
  await assert.rejects(NodeCapsuleOwner.open({ stateDirectory }), { code: 'CAPSULE_OWNER_BUSY' })
  assert.match(await body(created.endpoint.url), /original/u)
})

test('injection failure is visible while the original HTML remains usable', async (t) => {
  const { owner, source } = await fixture(t, {
    injection: {
      async html() {
        throw new Error('adapter unavailable')
      },
    },
  })
  const page = await owner.call('capsule.create', {
    operationId: 'injection-failure',
    sourcePath: source,
    mode: 'injected',
  })
  assert.match(await body(page.endpoint.url), /original/u)
  assert.ok(
    (await owner.call('capsule.inspect', { capsuleId: page.record.capsuleId })).issues.some(
      (x) => x.code === 'CAPSULE_INJECTION_UNAVAILABLE',
    ),
  )
})

test('lost storage confirmations retain pending effects and reconcile exact originals without replay', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'amux-capsule-fault-'))
  const source = join(directory, 'source'),
    stateDirectory = join(directory, 'state')
  await mkdir(source)
  await writeFile(join(source, 'index.html'), 'before-fault')
  const child = fork(new URL('./fault-worker.mjs', import.meta.url), [], {
    env: { ...process.env, CAPSULE_TEST_STATE: stateDirectory },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  })
  t.after(async () => {
    if (child.exitCode === null && !child.killed) {
      child.kill('SIGKILL')
      await once(child, 'exit')
    }
    await rm(directory, { recursive: true, force: true })
  })
  const [ready] = await once(child, 'message')
  assert.equal(ready.ready, true)
  let sequence = 0
  function call(method, params) {
    const id = ++sequence
    return new Promise((resolve, reject) => {
      const listener = (message) => {
        if (message.id !== id) return
        child.off('message', listener)
        message.error
          ? reject(Object.assign(new Error(message.error.message), { code: message.error.code }))
          : resolve(message.result)
      }
      child.on('message', listener)
      child.send({ id, method, params })
    })
  }
  const created = await call('capsule.create', { operationId: 'fault-page', sourcePath: source })
  await writeFile(join(source, 'index.html'), 'after-fault')
  await call('fault', { mode: 'record-sync' })
  await assert.rejects(
    call('capsule.update', {
      capsuleId: created.record.capsuleId,
      operationId: 'lost-sync',
      expectedRevision: 1,
      changes: { sourcePath: source },
    }),
    { code: 'CAPSULE_OPERATION_UNKNOWN' },
  )
  assert.equal(
    (await call('capsule.operation.inspect', { operationId: 'lost-sync' })).operation.status,
    'pending',
  )
  await call('fault', { mode: null })
  const confirmed = (await call('capsule.operation.inspect', { operationId: 'lost-sync' })).operation
  assert.equal(confirmed.status, 'committed')
  assert.equal(confirmed.result.record.revision, 2)
  assert.equal(await body(created.endpoint.url), 'after-fault')
  await call('fault', { mode: 'deletion-final-write' })
  await assert.rejects(
    call('capsule.remove', {
      capsuleId: created.record.capsuleId,
      operationId: 'lost-delete',
      expectedRevision: 2,
      deleteContent: true,
    }),
    { code: 'CAPSULE_OPERATION_UNKNOWN' },
  )
  await call('fault', { mode: null })
  const deletion = (await call('capsule.operation.inspect', { operationId: 'lost-delete' })).operation
  assert.equal(deletion.status, 'committed')
  assert.equal(deletion.result.deletedContent, true)
  await assert.rejects(readFile(join(created.record.contentRoot, 'index.html')), { code: 'ENOENT' })
  await call('close', {})
})

test(
  'presentation callbacks can reenter readers and observe the original pending open',
  { timeout: 5000 },
  async (t) => {
    let owner
    const setup = await fixture(t, {
      presentation: {
        async open(params, context, resolved) {
          const inspection = await owner.call('capsule.inspect', { capsuleId: params.capsuleId })
          const original = await owner.call('capsule.operation.inspect', { operationId: params.operationId })
          assert.equal(original.operation.status, 'pending')
          assert.equal(inspection.endpoint.url, resolved.endpoint.url)
          assert.equal(await body(resolved.endpoint.url), await body(inspection.endpoint.url))
          return {
            ...resolved,
            operationId: params.operationId,
            rendering: {
              status: 'available',
              browserId: 'browser-original',
              tabId: 'tab-original',
              regionId: 'region-original',
            },
          }
        },
      },
    })
    owner = setup.owner
    const page = await owner.call('capsule.create', {
      operationId: 'reentrant-page',
      sourcePath: setup.source,
    })
    const opened = await owner.call('capsule.open', {
      operationId: 'reentrant-open',
      capsuleId: page.record.capsuleId,
    })
    assert.equal(opened.rendering.browserId, 'browser-original')
    assert.equal(
      (await owner.call('capsule.operation.inspect', { operationId: 'reentrant-open' })).operation.status,
      'committed',
    )
  },
)

test(
  'closing an owner cancels only its presentation observation and retains the unknown operation',
  { timeout: 5000 },
  async (t) => {
    const { owner, source, stateDirectory } = await fixture(t, {
      presentation: {
        open() {
          return new Promise(() => {})
        },
      },
    })
    const page = await owner.call('capsule.create', { operationId: 'cancel-page', sourcePath: source })
    const pending = owner.call('capsule.open', {
      operationId: 'cancel-open',
      capsuleId: page.record.capsuleId,
    })
    const rejection = assert.rejects(pending, { code: 'CAPSULE_OPERATION_UNKNOWN' })
    for (;;) {
      const observed = await owner.call('capsule.operation.inspect', { operationId: 'cancel-open' })
      if (observed.operation) break
      await new Promise((resolve) => setImmediate(resolve))
    }
    await owner.close()
    await rejection
    const recovered = await NodeCapsuleOwner.open({ stateDirectory })
    t.after(() => recovered.close())
    assert.equal(
      (await recovered.call('capsule.operation.inspect', { operationId: 'cancel-open' })).operation.status,
      'pending',
    )
    assert.match(
      await body(
        (await recovered.call('capsule.resolve', { capsuleId: page.record.capsuleId })).endpoint.url,
      ),
      /original/u,
    )
  },
)
