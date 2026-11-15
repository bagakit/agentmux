const assert = require('node:assert/strict')

const focus = '.global-focus-surface:not([hidden])'
const trigger = focus + ' .focus-view-switch button[aria-label="Task layout"]'
const menu = '[role="menu"][aria-label="Task layout"]'
const choices = menu + ' [role="menuitemradio"]'

function taskLayoutControls({ click, read, until }) {
  async function open() {
    await click(trigger)
    await until('visible task layout menu', () => read(`Boolean(document.querySelector(${JSON.stringify(menu)}))`))
  }

  async function checked(value) {
    const options = await read(`Array.from(document.querySelectorAll(${JSON.stringify(choices)})).map(item => ({label: item.textContent.trim(), checked: item.getAttribute('aria-checked')}))`)
    assert.deepEqual(options, [
      {label: 'Cards', checked: String(value === 'cards')},
      {label: 'Compact list', checked: String(value === 'list')},
    ])
  }

  async function close() {
    await until('task layout menu closed', () => read(`!document.querySelector(${JSON.stringify(menu)})`))
  }

  async function choose(value) {
    await open()
    await click(choices + `[data-focus-layout="${value}"]`)
    await close()
  }

  return { open, checked, close, choose }
}

module.exports = { focus, trigger, menu, taskLayoutControls }
