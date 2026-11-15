const assert = require('node:assert/strict')
const { isDeepStrictEqual } = require('node:util')

async function run({ win, read, q, button, until, settle, click, type, scene, capture, result }) {
  const editor = '[data-prompt-editor="explain"]'
  const prompt = q(`${editor} textarea`)
  const preview = q(`${editor} [data-ui-markdown-preview]`)
  const cdp = win.webContents.debugger
  const short = '# Review changes\nUse **evidence** and `git diff`.'
  const source = [
    '## Checklist',
    '- Verify **behaviour** before describing the change.  ',
    '- Cite `git diff` and [the docs](./README.md).',
    '',
    '> Record what remains unknown.',
    '',
    '```sh',
    'pnpm test',
    '```',
    ''
  ].join('\n')
  const wrapped = 'Check the changed files against the **original request** and quote the exact evidence for each observation before writing the appendix for the summary.'
  const long = [
    '## Evidence',
    wrapped,
    ...Array.from({ length: 24 }, (_, index) => `- Step ${index + 1}. Cite the concrete result before describing the next action.`),
    '> The conclusion records the last observation.',
    ''
  ].join('\n')
  const saved = config => config.composerShortcuts.find(item => item.id === 'explain').body
  const promptWrites = () => result.saves.filter(write => !isDeepStrictEqual(write.next.composerShortcuts, write.expected.composerShortcuts))
  const editing = result.markdown = {}

  async function paint() {
    return read(`(() => {
      const field = ${prompt}, layer = ${preview}, css = getComputedStyle(field)
      const tokens = [...(layer?.querySelectorAll('[data-markdown-token]') ?? [])]
      return {
        fields: document.querySelectorAll('${editor} textarea, ${editor} [contenteditable]').length,
        previews: document.querySelectorAll('${editor} [data-ui-markdown-preview]').length,
        hidden: layer?.getAttribute('aria-hidden') ?? null,
        visible: layer?.checkVisibility({ opacityProperty: true, visibilityProperty: true }) ?? false,
        pointer: layer ? getComputedStyle(layer).pointerEvents : null,
        ink: css.webkitTextFillColor || css.color,
        caret: css.caretColor,
        source: field.value, projected: layer?.textContent ?? null,
        types: [...new Set(tokens.map(token => token.dataset.markdownToken))],
        colors: [...new Set(tokens.map(token => getComputedStyle(token).color))],
        sameField: field === window.markdownOriginalField && field.isConnected,
        focused: field === document.activeElement,
        selection: [field.selectionStart, field.selectionEnd],
        height: field.offsetHeight, clientHeight: field.clientHeight, scrollHeight: field.scrollHeight,
        scrollTop: field.scrollTop, line: parseFloat(css.lineHeight),
        insets: parseFloat(css.paddingBlockStart) + parseFloat(css.paddingBlockEnd) +
          parseFloat(css.borderBlockStartWidth) + parseFloat(css.borderBlockEndWidth)
      }
    })()`)
  }

  async function expectMarkdown(value) {
    const facts = await paint()
    assert.equal(facts.previews, 1, 'Prompt has one decorative Markdown projection')
    assert.equal(facts.fields, 1, 'One native field owns Prompt editing')
    assert.ok(facts.sameField && facts.focused, 'The original connected native textarea retains focus')
    assert.equal(facts.source, value, 'The native field holds the original Markdown source')
    assert.equal(facts.projected, value, 'The projection preserves every character, including whitespace and delimiters')
    assert.deepEqual({ hidden: facts.hidden, visible: facts.visible, pointer: facts.pointer },
      { hidden: 'true', visible: true, pointer: 'none' }, 'The visible projection stays decorative and click-through')
    assert.equal(facts.ink, 'rgba(0, 0, 0, 0)', 'There is one painted copy of the text during Markdown editing')
    assert.notEqual(facts.caret, facts.ink, 'The native caret remains visible')
    return facts
  }

  async function assertCaretAt(value, word, softWrapped = false) {
    const offset = value.indexOf(word) + 1
    assert.ok(offset > 0, 'The input contains the intended pointer target')
    const lineStart = value.lastIndexOf('\n', offset - 1) + 1
    const point = await read(`(() => {
      const layer = ${preview}, field = ${prompt}
      const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT)
      const range = document.createRange()
      function charRect(offset) {
        walker.currentNode = layer
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (offset < node.data.length) {
            range.setStart(node, offset)
            range.setEnd(node, offset + 1)
            return range.getBoundingClientRect()
          }
          offset -= node.data.length
        }
        throw Error('Projected character is missing')
      }
      const character = charRect(${offset}), line = charRect(${lineStart})
      const x = character.left + character.width / 4, y = character.top + character.height / 2
      return { x, y, wrapDelta: character.top - line.top, charWidth: character.width,
        hitsNativeField: document.elementFromPoint(x, y) === field, scrollTop: field.scrollTop }
    })()`)
    assert.ok(point.charWidth > 0 && point.hitsNativeField, JSON.stringify(point))
    if (softWrapped) assert.ok(point.wrapDelta > 0, 'The target comes after a genuine soft wrap')
    await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await settle()
    const facts = await expectMarkdown(value)
    assert.deepEqual(facts.selection, [offset, offset], 'Clicking a projected glyph reaches the same original character')
    return { ...point, offset, selection: facts.selection }
  }

  await scene(1480, 'dark')
  assert.equal(await read('document.querySelectorAll("[data-prompt-id]").length'), 17)
  await read(`window.markdownOriginalField = ${prompt}`)
  await type(prompt, short)
  editing.compact = await expectMarkdown(short)
  assert.ok(editing.compact.types.includes('heading') && editing.compact.types.length >= 3, 'Heading, emphasis and inline code are tokenized')
  assert.ok(editing.compact.colors.length > 1, 'The theme differentiates Markdown source tokens')
  assert.ok(editing.compact.height <= Math.ceil(2 * editing.compact.line + editing.compact.insets), 'A two-line Markdown draft fits the compact editor')
  await capture('prompt-markdown-1480-dark.png', 'Compact focused Prompt with Markdown source in a populated library')

  await read(`(${prompt}).setSelectionRange(2, 8)`)
  await click(button('More space'))
  editing.expanded = await expectMarkdown(short)
  assert.ok(editing.expanded.height > 2 * editing.compact.height, 'Expansion uses the same original field')
  assert.deepEqual(editing.expanded.selection, [2, 8])
  await type(prompt, source)
  await expectMarkdown(source)
  await capture('prompt-markdown-1480-dark-expanded.png', 'Expanded field with lists, inline Markdown, quote, fence and trailing newline')
  await click(button('Less space'))
  await type(prompt, short)
  assert.equal((await expectMarkdown(short)).height, editing.compact.height, 'Shortening returns the original compact height')

  await scene(520, 'light')
  await type(prompt, wrapped)
  editing.wrapped = await assertCaretAt(wrapped, 'appendix', true)
  await capture('prompt-markdown-520-light.png', 'Narrow light Prompt with a caret on a naturally wrapped line')

  await type(prompt, long)
  const longFacts = await expectMarkdown(long)
  assert.ok(longFacts.clientHeight > editing.compact.clientHeight && longFacts.scrollHeight > longFacts.clientHeight,
    'The longer Markdown draft grows within its compact limit and scrolls within the textarea')
  const wheel = await read(`(() => {
    const field = ${prompt}
    field.scrollTop = 0
    const r = field.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)
  await settle()
  await cdp.sendCommand('Input.dispatchMouseEvent', {
    type: 'mouseWheel', ...wheel, deltaX: 0, deltaY: longFacts.scrollHeight
  })
  await until(`(${prompt}).scrollTop > 0`)
  await settle()
  editing.scrolled = await assertCaretAt(long, 'conclusion')
  assert.ok(editing.scrolled.scrollTop > 0, 'The click aligns after scrolling the native viewport')
  await capture('prompt-markdown-520-light-scrolled.png', 'Long Prompt scrolled within the original field with the library Save reachable')

  await type(prompt, source)
  await expectMarkdown(source)
  await read(`(() => {
    const field = ${prompt}
    field.setSelectionRange(field.value.length, field.value.length)
    window.markdownNativeEvents = []
    for (const name of ['compositionstart', 'compositionend', 'input']) {
      field.addEventListener(name, event => markdownNativeEvents.push({
        name, trusted: event.isTrusted, inputType: event.inputType ?? null
      }))
    }
  })()`)
  const committed = source + '中文'
  await cdp.sendCommand('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 })
  await until(`(${prompt}).value === ${JSON.stringify(committed)}`)
  await settle()
  editing.composing = await paint()
  assert.ok(editing.composing.sameField && editing.composing.focused && !editing.composing.visible,
    'Native IME composition keeps the same field and hides the colored projection')
  assert.notEqual(editing.composing.ink, 'rgba(0, 0, 0, 0)', 'In-progress IME has native visible text')
  await cdp.sendCommand('Input.insertText', { text: '中文' })
  await until('markdownNativeEvents.some(event => event.name === "compositionend")')
  await settle()
  editing.committed = await expectMarkdown(committed)

  for (const eventType of ['keyDown', 'keyUp']) {
    await cdp.sendCommand('Input.dispatchKeyEvent', {
      type: eventType, key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90,
      modifiers: process.platform === 'darwin' ? 4 : 2,
      ...(eventType === 'keyDown' ? { commands: ['undo'] } : {})
    })
  }
  await settle()
  editing.undo = await expectMarkdown(source)
  editing.nativeEvents = await read('window.markdownNativeEvents')
  const compositionEvents = editing.nativeEvents.filter(event => event.name.startsWith('composition'))
  assert.deepEqual(compositionEvents.map(event => event.name), ['compositionstart', 'compositionend'])
  assert.ok(compositionEvents[0].trusted && editing.nativeEvents.some(event => event.trusted && event.inputType === 'insertCompositionText'),
    'Composition starts with a trusted Chromium edit and reaches its end event')
  assert.ok(editing.nativeEvents.some(event => event.trusted && event.inputType === 'historyUndo'), 'Undo came from Chromium native history')

  await cdp.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] })
  await settle()
  assert.ok(await read('matchMedia("(forced-colors: active)").matches'))
  editing.forcedColors = await paint()
  assert.ok(editing.forcedColors.sameField && editing.forcedColors.focused && !editing.forcedColors.visible)
  assert.notEqual(editing.forcedColors.ink, 'rgba(0, 0, 0, 0)', 'Forced colors show native readable text')
  await cdp.sendCommand('Emulation.setEmulatedMedia', { features: [] })
  await settle()
  await expectMarkdown(source)

  assert.equal(promptWrites().length, 0, 'Editing, composition and undo leave the saved Prompt library untouched')
  assert.equal(saved(await read('window.promptsProbe.config()')), saved(result.startedConfig), 'Private ConfigOwner still has the original saved Prompt before Save')
  await click(button('Save prompts'))
  await until(`window.promptsProbe.config().then(config => config.composerShortcuts.find(item => item.id === 'explain').body === ${JSON.stringify(source)})`)
  assert.equal(promptWrites().length, 1)
  assert.equal(saved(result.commits.at(-1)), source, 'The original Save action commits the literal Markdown source')
  assert.deepEqual(result.commits.at(-1).composerShortcuts, result.startedConfig.composerShortcuts.map(
    item => item.id === 'explain' ? { ...item, body: source } : item
  ), 'Other Prompts retain their authored content')
  editing.savedSource = source
}

module.exports = { run }
