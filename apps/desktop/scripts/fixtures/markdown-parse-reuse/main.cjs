const { app, BrowserWindow } = require('electron')
const fs = require('node:fs/promises'), assert = require('node:assert/strict')
const [html, profile, output, variant] = process.argv.slice(2)
app.setPath('userData', profile)
let win
app.whenReady().then(async () => {
  const report = { passed: false, variant, pid: process.pid, electron: process.versions.electron, userRunTouched: false, naturalFreezeAttribution: false }
  try {
    win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
    await win.loadFile(html)
    const evaluate = code => win.webContents.executeJavaScript(code), deadline = Date.now() + 10_000
    while (!await evaluate('Boolean(window.markdownParseReuse)')) { assert.ok(Date.now() < deadline, 'Actual production consumer must mount'); await new Promise(resolve => setTimeout(resolve, 10)) }
    report.conversation = await evaluate('markdownParseReuse.conversation()')
    const conversation = report.conversation
    assert.equal(conversation.initialCalls, 1)
    assert.equal(conversation.unchangedCalls, 1, 'Unchanged production Conversation body must not repeat grammar parsing for fresh Host callbacks')
    assert.ok(conversation.changed.text.includes('Fresh changed body'), 'Changed content must reach the actual current DOM')
    assert.ok(!conversation.changed.text.includes('Current body'))
    assert.equal(conversation.finalCalls, 2)
    assert.ok(conversation.snapshots.every(snapshot => snapshot.bodySame))
    assert.deepEqual(conversation.actions, [{ generation: 20, kind: 'http', url: 'https://example.com/reuse' }, { generation: 21, kind: 'http', url: 'https://example.com/new' }])
    report.modes = await evaluate('markdownParseReuse.modes()')
    const modes = report.modes.snapshots
    assert.equal(modes[0].text, '<https://example.com/reuse>'); assert.equal(modes[0].links.length, 0)
    assert.equal(modes[1].input, true); assert.equal(modes[1].links.length, 1)
    assert.equal(modes[2].text, '<https://example.com/reuse>'); assert.equal(modes[2].input, false)
    assert.equal(modes[3].heading, '# Heading'); assert.equal(modes[3].headingTag, 'P')
    assert.equal(modes[4].heading, 'Heading'); assert.equal(modes[4].headingTag, 'H1')
    assert.equal(modes[4].calls, modes[3].calls, 'Presentation-only document/input change keeps the same effective block grammar')
    assert.equal(modes[5].outline, true); assert.equal(modes[6].outline, false); assert.equal(modes[7].outline, true)
    assert.equal(modes[8].text, 'Fresh plain prose.'); assert.equal(modes[8].document, false)
    report.currentActions = await evaluate('markdownParseReuse.currentActions()')
    const current = report.currentActions
    assert.equal(current.first.calls, current.second.calls, 'Current path/context/image adapters must not invalidate the unchanged AST')
    assert.deepEqual(current.first.images, ['0:docs/image.png:Image']); assert.deepEqual(current.second.images, ['1:notes/image.png:Image'])
    assert.equal(current.first.links.find(link => link.text === 'Absolute').title, 'repo/src/absolute.ts')
    assert.equal(current.second.links.find(link => link.text === 'Absolute').title, 'src/absolute.ts')
    assert.deepEqual(current.actions.slice(0, 4), [{ generation: 1, kind: 'http', url: 'https://example.com/current' },
      { generation: 1, kind: 'file', path: 'notes/a.ts', location: { line: 9, column: 2 } }, { generation: 1, kind: 'file', path: 'new-home/src/home.ts', location: undefined },
      { generation: 1, kind: 'file', path: 'src/absolute.ts', location: undefined }])
    assert.equal(current.inert.links.length, 0); assert.equal(current.inert.images.length, 0)
    assert.equal(current.object.object, '3'); assert.equal(current.freshObject.object, '4')
    assert.deepEqual(current.actions.slice(4), [{ generation: 3, kind: 'object', uri: 'amux://agent/private-agent' }, { generation: 4, kind: 'object', uri: 'amux://agent/private-agent' }])
    assert.deepEqual(current.image.images, ['5:attachment:plot.png:Attachment']); assert.deepEqual(current.freshImage.images, ['6:attachment:plot.png:Attachment'])
    report.instances = await evaluate('markdownParseReuse.instances()')
    assert.equal(report.instances.two, 2); assert.equal(report.instances.afterRemount, 3)
    report.passed = true
  } catch (error) { report.failure = { name: error.name, message: error.message, stack: error.stack } }
  finally { await fs.writeFile(output, JSON.stringify(report, null, 2)); win?.destroy(); app.exit(report.passed ? 0 : 1) }
})
