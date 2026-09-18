import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { activate, click, key } from './desktop.mjs'
import { replaceFontText } from './font.mjs'

// Read the actual product vocabulary. Erasing TypeScript types does not replace any
// product API; these modules contain only vocabulary and pure presentation functions.
export async function preferenceVocabulary(repositoryRoot) {
  const ts = createRequire(import.meta.url)('typescript')
  const load = async path => {
    const source = await readFile(join(repositoryRoot, path), 'utf8')
    const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
    assert.ok(output.length > 0)
    return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`)
  }
  const [toolbar, labels, notifications] = await Promise.all([
    load('apps/desktop/src/shared/browser-toolbar.ts'),
    load('apps/desktop/src/renderer/src/lib/browser-toolbar.ts'),
    load('apps/desktop/src/shared/notification-presentation.ts')
  ])
  assert.ok(toolbar.BROWSER_TOOLBAR_ITEM_ORDER.length > 0)
  assert.deepEqual(Object.keys(labels.BROWSER_TOOLBAR_ITEM_LABELS).sort(), [...toolbar.BROWSER_TOOLBAR_ITEM_ORDER].sort())
  assert.ok(notifications.NOTIFICATION_TIERS.length > 0)
  const catalogSource = await readFile(join(repositoryRoot, 'apps/desktop/src/renderer/src/lib/terminal-theme.ts'), 'utf8')
  const catalogFile = ts.createSourceFile('terminal-theme.ts', catalogSource, ts.ScriptTarget.Latest, true)
  const declarations = catalogFile.statements.filter(ts.isVariableStatement).flatMap(statement => [...statement.declarationList.declarations])
  const catalogs = declarations.filter(declaration => declaration.name.getText(catalogFile) === 'TERMINAL_THEME_CATALOG')
  assert.equal(catalogs.length, 1)
  const initializer = catalogs[0].initializer
  assert.ok(ts.isCallExpression(initializer) && initializer.expression.getText(catalogFile) === 'Object.freeze')
  const catalog = initializer.arguments[0]
  assert.ok(ts.isArrayLiteralExpression(catalog) && catalog.elements.length > 0)
  const terminalThemes = catalog.elements.map(element => {
    assert.ok(ts.isObjectLiteralExpression(element))
    const text = name => {
      const properties = element.properties.filter(property => ts.isPropertyAssignment(property) && property.name.getText(catalogFile) === name)
      assert.equal(properties.length, 1); assert.ok(ts.isStringLiteral(properties[0].initializer))
      return properties[0].initializer.text
    }
    return { id: text('id'), label: text('label') }
  })
  return { toolbarOrder: toolbar.BROWSER_TOOLBAR_ITEM_ORDER, toolbarLabels: labels.BROWSER_TOOLBAR_ITEM_LABELS,
    notificationTiers: notifications.NOTIFICATION_TIERS, terminalThemes }
}

const nodes = selector => `Array.from(document.querySelectorAll(${JSON.stringify(selector)}))`
const pane = id => `[data-settings-pane="${id}"]:not([hidden])`
const values = entries => Object.fromEntries(entries.map(entry => [entry.key, entry.value]))

export function preferenceProof({ probe, vocabulary, entries, set, command, configPath, waitFor, section, saved, ui, phase }) {
  let supported, toolbarEntries
  const facts = { initialNochange: [], scalarMatrix: {}, ui: {} }
  const allValues = async () => values(await entries())
  const one = async name => {
    const selected = await entries(name)
    assert.equal(selected.length, 1); assert.equal(selected[0].key, name)
    return selected[0]
  }
  const publications = async () => (await ui(probe)).events.length
  const readConfig = async () => JSON.parse(await readFile(configPath, 'utf8'))
  const at = (config, path) => path.split('.').reduce((current, part) => current?.[part], config)
  const permissions = async () => {
    const config = await readConfig()
    return { automation: config.browser.agentAutomation, schemes: config.browser.appLinkSchemes }
  }
  const settingsVisible = () => probe.cdp.evaluate('Boolean(document.querySelector(".settings-page"))')
  const showSettings = async shown => {
    if (await settingsVisible() !== shown) await activate(probe.cdp, nodes('.window-status-bar button[aria-label="Settings"]'))
    await waitFor(`Settings visibility ${shown}`, async () => await settingsVisible() === shown)
  }
  const save = async (id, label) => {
    await activate(probe.cdp, `${nodes(`${pane(id)} button`)}.filter(e=>e.textContent.trim()===${JSON.stringify(label)})`)
    await saved(probe)
  }
  const numericInput = async (selector, value) => {
    await replaceFontText(probe.cdp, selector, String(value))
  }
  const range = async (selector, index) => {
    assert.equal(await probe.cdp.evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)});e.focus();return document.activeElement===e})()`), true)
    await key(probe.cdp, 'Home', 'Home')
    for (let step = 0; step < index; step++) await key(probe.cdp, 'ArrowRight', 'ArrowRight')
    await waitFor(`native slider index ${index}`, () => probe.cdp.evaluate(`Number(document.querySelector(${JSON.stringify(selector)}).value)===${index}`))
  }
  const notificationUI = () => probe.cdp.evaluate(`(() => {
    const root=document.querySelector(${JSON.stringify(pane('notifications'))}), slider=root.querySelector('[aria-label="Notification dwell"]'), sound=root.querySelector('.notification-sound-toggle input')
    return {index:Number(slider.value),label:slider.getAttribute('aria-valuetext'),sound:sound.checked,soundDisabled:sound.disabled,
      alert:root.querySelector('[role="alert"]')?.textContent??'',saveDisabled:root.querySelector('.settings-pane-actions button').disabled}
  })()`)
  const toolbarUI = () => probe.cdp.evaluate(`(() => {
    const root=document.querySelector('.browser-tools-preferences')
    return {items:Array.from(root.querySelectorAll('label')).map(label=>({label:label.querySelector('span').textContent,checked:label.querySelector('input').checked})),
      alert:root.querySelector('.settings-inline-error[role="alert"]')?.textContent??'',saveDisabled:root.querySelector('button').disabled,saveText:root.querySelector('button').textContent.trim()}
  })()`)
  const toolbarCheckbox = name => `${nodes('.browser-tools-preferences label')}.filter(e=>e.querySelector('span')?.textContent===${JSON.stringify(vocabulary.toolbarLabels[name])}).map(e=>e.querySelector('input'))`
  const toggleToolbar = async name => {
    // Select the named real label first, then pass its measured checkbox to native mouse input.
    const selector = `.browser-tools-preferences label:nth-of-type(${vocabulary.toolbarOrder.indexOf(name) + 1}) input`
    assert.equal(await probe.cdp.evaluate(`(${toolbarCheckbox(name)}).length`), 1)
    await click(probe.cdp, selector)
  }
  const showToolbar = async () => {
    await showSettings(false)
    if (!(await probe.cdp.evaluate('Boolean(document.querySelector("[data-surface-tool-dock]"))'))) {
      await activate(probe.cdp, nodes('[data-surface-tools-toggle][aria-label="Show Space tools"]'))
    }
    await activate(probe.cdp, nodes('.surface-tool-activitybar button[aria-label="Browser Tools"]'))
    await waitFor('actual Browser bar preferences', () => probe.cdp.evaluate('Boolean(document.querySelector(".browser-tools-preferences"))'))
    const actual = (await toolbarUI()).items
    assert.deepEqual(actual.map(item => item.label), vocabulary.toolbarOrder.map(name => vocabulary.toolbarLabels[name]))
    assert.ok(actual.length > 0)
  }
  const saveToolbar = async () => {
    await activate(probe.cdp, `${nodes('.browser-tools-preferences button')}.filter(e=>e.textContent.trim()==='Save Browser bar')`)
    await waitFor('Browser bar durable save', async () => { const state=await toolbarUI();return state.saveText==='Save Browser bar' && state.saveDisabled && !state.alert })
  }
  const railUI = () => probe.cdp.evaluate('document.querySelector(".project-rail").dataset.railDensity??"default"')

  async function initialize() {
    phase('ordinary-metadata-and-effective-nochange')
    supported = await entries()
    toolbarEntries = supported.filter(entry => entry.key.startsWith('browser.toolbar.'))
    assert.ok(toolbarEntries.length > 0)
    assert.deepEqual(toolbarEntries.map(entry => entry.key).sort(), vocabulary.toolbarOrder.map(name => `browser.toolbar.${name}`).sort())
    const ordinary = ['appearance.appAppearance', 'appearance.terminalTheme', 'appearance.terminalFontSize',
      'notifications.mode', 'notifications.sound', 'projectRailDensity', 'copyPathsAsAbsolute']
    assert.deepEqual(supported.map(entry => entry.key).sort(), [...ordinary, ...toolbarEntries.map(entry => entry.key)].sort())
    assert.equal(supported.length, 13)
    for (const entry of supported) {
      assert.equal(typeof entry.default, entry.kind); assert.equal(typeof entry.value, entry.kind)
      if (entry.kind !== 'boolean') { assert.ok(entry.enum?.length > 1); assert.ok(entry.enum.includes(entry.default)); assert.ok(entry.enum.includes(entry.value)) }
    }
    assert.deepEqual((await one('notifications.mode')).enum, vocabulary.notificationTiers.map(tier => tier.id))
    const before = await readFile(configPath), count = await publications()
    for (const entry of supported) {
      await set(entry.key, String(entry.value))
      assert.deepEqual(await readFile(configPath), before, `Setting effective current value writes no bytes: ${entry.key}`)
      assert.equal(await publications(), count, `Setting effective current value publishes nothing: ${entry.key}`)
      facts.initialNochange.push(entry.key)
    }
    assert.deepEqual(await allValues(), values(supported))
    facts.metadata = supported
    return supported
  }

  async function exercise() {
    const originalPermissions = await permissions()
    phase('ordinary-scalar-matrix')
    for (const entry of supported) {
      const before = await one(entry.key), count = await publications(), bytes = await readFile(configPath)
      await set(entry.key, String(entry.default))
      assert.equal((await one(entry.key)).value, entry.default)
      if (before.value === entry.default) { assert.deepEqual(await readFile(configPath), bytes); assert.equal(await publications(), count) }
      else { await waitFor(`default commit published: ${entry.key}`, async () => await publications() > count); assert.equal(await publications(), count + 1) }
      const alternate = entry.kind === 'boolean' ? !entry.default : entry.enum.find(value => value !== entry.default)
      assert.notEqual(alternate, undefined)
      const beforeAlternate = await publications()
      await set(entry.key, String(alternate))
      assert.equal((await one(entry.key)).value, alternate); assert.equal(at(await readConfig(), entry.key), alternate)
      await waitFor(`alternate commit published: ${entry.key}`, async () => await publications() > beforeAlternate)
      assert.equal(await publications(), beforeAlternate + 1)
      const invalid = entry.kind === 'number' ? ['NaN', 'Infinity', String(Math.min(...entry.enum) - 1), String(Math.max(...entry.enum) + 1), String(entry.enum[0] + 0.5), '', ' ']
        : entry.kind === 'boolean' ? ['TRUE', '1'] : ['invalid-private-value']
      const committedBytes = await readFile(configPath), committedCount = await publications()
      for (const value of invalid) {
        const rejected = await command(['settings', 'set', entry.key, value], 1)
        assert.equal(rejected.error.code, 'INVALID_SETTING_VALUE')
        assert.deepEqual(await readFile(configPath), committedBytes); assert.equal(await publications(), committedCount)
      }
      await set(entry.key, String(alternate))
      assert.deepEqual(await readFile(configPath), committedBytes); assert.equal(await publications(), committedCount)
      facts.scalarMatrix[entry.key] = { default: entry.default, alternate, invalid, nochange: true }
    }
    assert.deepEqual(Object.keys(facts.scalarMatrix).sort(), supported.map(entry => entry.key).sort())
    for (const name of ['browser.agentAutomation', 'browser.appLinkSchemes.privatesettings']) {
      const bytes = await readFile(configPath), count = await publications()
      const rejected = await command(['settings', 'set', name, 'true'], 1)
      assert.equal(rejected.error.code, 'UNSUPPORTED_SETTING')
      const unreadable = await command(['settings', 'get', name], 1)
      assert.equal(unreadable.error.code, 'UNSUPPORTED_SETTING')
      assert.deepEqual(await readFile(configPath), bytes); assert.equal(await publications(), count)
    }

    phase('ordinary-appearance-ui')
    await section(probe, 'Appearance', 'appearance')
    const theme = await one('appearance.terminalTheme'), themeNext = theme.enum.find(value => value !== theme.value)
    const selectedTheme = () => probe.cdp.evaluate(`document.querySelector(${JSON.stringify(`${pane('appearance')} [aria-label="Terminal palette"] input[type="radio"]:checked`)}).getAttribute('aria-label')`)
    const themeLabels = await probe.cdp.evaluate(`${nodes(`${pane('appearance')} [aria-label="Terminal palette"] strong`)}.map(e=>e.textContent)`)
    assert.deepEqual(vocabulary.terminalThemes.map(definition => definition.id).sort(), [...theme.enum].sort())
    assert.deepEqual(themeLabels, vocabulary.terminalThemes.map(definition => definition.label))
    const labelFor = id => vocabulary.terminalThemes.find(definition => definition.id === id).label
    await set(theme.key, themeNext)
    await waitFor('CLI palette reaches actual current UI', async () => await selectedTheme() === labelFor(themeNext))
    await click(probe.cdp, `${pane('appearance')} .terminal-theme-choice:has(input[aria-label=${JSON.stringify(labelFor(theme.value))}])`)
    await save('appearance', 'Save appearance'); assert.equal((await one(theme.key)).value, theme.value)
    const font = await one('appearance.terminalFontSize'), nextFont = font.enum.find(value => value !== font.value)
    const bounds = await probe.cdp.evaluate(`(() => { const e=document.querySelector(${JSON.stringify(`${pane('appearance')} input[aria-label="Terminal font size in pixels"]`)});return {min:Number(e.min),max:Number(e.max),step:Number(e.step)} })()`)
    assert.equal(bounds.step, 1)
    assert.deepEqual(font.enum, Array.from({ length: bounds.max - bounds.min + 1 }, (_, index) => bounds.min + index))
    await set(font.key, String(nextFont)); await waitFor('CLI font reaches actual input', async () => (await ui(probe)).font === nextFont)
    await numericInput(`${pane('appearance')} input[aria-label="Terminal font size in pixels"]`, font.value)
    await save('appearance', 'Save appearance'); assert.equal((await one(font.key)).value, font.value)
    facts.ui.appearance = { theme: (await one(theme.key)).value, font: (await one(font.key)).value }

    phase('ordinary-notifications-ui')
    await section(probe, 'Notifications', 'notifications')
    const mode = await one('notifications.mode'), sound = await one('notifications.sound')
    const activeMode = mode.enum.find(value => value !== 'off' && value !== mode.value)
    await set(mode.key, activeMode)
    await waitFor('CLI notification mode reaches actual slider', async () => (await notificationUI()).index === mode.enum.indexOf(activeMode))
    const nextIndex = (mode.enum.indexOf(activeMode) + 1) % mode.enum.length
    await range(`${pane('notifications')} [aria-label="Notification dwell"]`, nextIndex)
    await save('notifications', 'Save notifications'); assert.equal((await one(mode.key)).value, mode.enum[nextIndex])
    await set(sound.key, 'false'); await waitFor('CLI sound reaches actual checkbox', async () => !(await notificationUI()).sound)
    await click(probe.cdp, `${pane('notifications')} .notification-sound-toggle input`)
    await save('notifications', 'Save notifications'); assert.equal((await one(sound.key)).value, true)
    const draftIndex = mode.enum.indexOf(activeMode)
    await range(`${pane('notifications')} [aria-label="Notification dwell"]`, draftIndex)
    await set(sound.key, 'false')
    await waitFor('disjoint notification sound consumed', async () => !(await notificationUI()).sound)
    assert.equal((await notificationUI()).index, draftIndex)
    await save('notifications', 'Save notifications')
    assert.equal((await one(mode.key)).value, activeMode); assert.equal((await one(sound.key)).value, false)
    const conflictingIndex = mode.enum.findIndex(value => value !== activeMode && value !== 'off')
    await range(`${pane('notifications')} [aria-label="Notification dwell"]`, conflictingIndex)
    await set(mode.key, 'off')
    assert.equal((await notificationUI()).index, conflictingIndex)
    await activate(probe.cdp, `${nodes(`${pane('notifications')} button`)}.filter(e=>e.textContent.trim()==='Save notifications')`)
    await waitFor('named notification conflict retains draft', async () => (await notificationUI()).alert.includes(mode.key))
    assert.equal((await notificationUI()).index, conflictingIndex); assert.equal((await notificationUI()).saveDisabled, false)
    assert.equal((await one(mode.key)).value, 'off')
    facts.ui.notificationsConflict = await notificationUI()
    await showSettings(false); await showSettings(true); await section(probe, 'Notifications', 'notifications')
    await set(sound.key, 'true')
    await waitFor('sound preference retained while mode off', async () => {const state=await notificationUI();return state.index===mode.enum.indexOf('off') && state.sound && state.soundDisabled})
    facts.ui.notifications = await notificationUI()

    phase('ordinary-toolbar-ui')
    await showToolbar()
    for (const entry of toolbarEntries) {
      const name = entry.key.slice('browser.toolbar.'.length)
      await set(entry.key, 'true')
      await waitFor(`CLI ${name} reaches actual checkbox`, async () => (await toolbarUI()).items.find(item => item.label === vocabulary.toolbarLabels[name])?.checked === true)
      await toggleToolbar(name); await saveToolbar(); assert.equal((await one(entry.key)).value, false)
    }
    const first = toolbarEntries[0], last = toolbarEntries.at(-1), name = first.key.slice('browser.toolbar.'.length)
    await toggleToolbar(name); await set(last.key, 'true')
    await waitFor('disjoint toolbar commit consumed', async () => (await toolbarUI()).items.find(item => item.label === vocabulary.toolbarLabels[last.key.slice('browser.toolbar.'.length)])?.checked === true)
    assert.equal((await toolbarUI()).items.find(item => item.label === vocabulary.toolbarLabels[name]).checked, true)
    await saveToolbar(); assert.equal((await one(first.key)).value, true); assert.equal((await one(last.key)).value, true)
    await toggleToolbar(name); await set(first.key, 'false')
    await waitFor('external same-field toolbar commit observed', async () => (await ui(probe)).events.at(-1)?.toolbar[name] === false)
    assert.equal((await toolbarUI()).saveDisabled, false, 'External value matching the dirty draft does not discard its old expectation')
    const matchingBytes = await readFile(configPath), matchingPublications = await publications(), matchingDraft = await toolbarUI()
    await saveToolbar()
    assert.equal((await toolbarUI()).items.find(item => item.label === vocabulary.toolbarLabels[name]).checked, false)
    assert.equal((await one(first.key)).value, false)
    assert.deepEqual(await readFile(configPath), matchingBytes, 'Explicit save of the already committed draft writes no bytes')
    assert.equal(await publications(), matchingPublications, 'Explicit matching save publishes nothing')
    facts.ui.toolbarMatchingSave = { key: first.key, before: matchingDraft, after: await toolbarUI(), configUnchanged: true,
      publicationsBefore: matchingPublications, publicationsAfter: await publications() }
    facts.ui.toolbar = await toolbarUI()

    phase('ordinary-rail-ui')
    const rail = await one('projectRailDensity'), nextRail = rail.enum.find(value => value !== rail.value)
    await set(rail.key, nextRail); await waitFor('CLI rail density reaches actual rail', async () => await railUI() === nextRail)
    const otherValues = await allValues()
    await activate(probe.cdp, `${nodes('.project-rail .sidebar__heading-actions button')}.filter(e=>/^Use .*project spacing$/.test(e.getAttribute('aria-label')??''))`)
    await waitFor('native rail action durably commits', async () => (await one(rail.key)).value !== nextRail)
    const afterRail = await allValues(); assert.equal(await railUI(), afterRail[rail.key]); assert.ok(rail.enum.includes(afterRail[rail.key]))
    assert.deepEqual(afterRail, { ...otherValues, [rail.key]: afterRail[rail.key] })
    facts.ui.rail = { value: afterRail[rail.key], actual: await railUI() }
    await set('appearance.appAppearance', 'light'); await set('copyPathsAsAbsolute', 'true')
    assert.deepEqual(await permissions(), originalPermissions)
    facts.permissions = originalPermissions
    facts.restartValues = await allValues()
    await showSettings(true); await section(probe, 'Copy Paths', 'copy-paths')
    return facts
  }

  async function verifyRestart(restoredProbe) {
    probe = restoredProbe
    assert.deepEqual(values(await entries()), facts.restartValues)
    await section(probe, 'Appearance', 'appearance')
    const actualTheme = await probe.cdp.evaluate(`document.querySelector(${JSON.stringify(`${pane('appearance')} [aria-label="Terminal palette"] input[type="radio"]:checked`)}).getAttribute('aria-label')`)
    assert.equal(actualTheme, vocabulary.terminalThemes.find(definition => definition.id === facts.restartValues['appearance.terminalTheme']).label)
    assert.equal((await ui(probe)).font, facts.restartValues['appearance.terminalFontSize'])
    await section(probe, 'Notifications', 'notifications')
    const notification = await notificationUI()
    assert.equal(notification.index, vocabulary.notificationTiers.findIndex(tier => tier.id === facts.restartValues['notifications.mode']))
    assert.equal(notification.sound, facts.restartValues['notifications.sound']); assert.equal(notification.soundDisabled, true)
    await showToolbar()
    const actualToolbar = await toolbarUI()
    assert.deepEqual(actualToolbar.items, vocabulary.toolbarOrder.map(name => ({ label: vocabulary.toolbarLabels[name], checked: facts.restartValues[`browser.toolbar.${name}`] })))
    assert.equal(await railUI(), facts.restartValues.projectRailDensity)
    assert.deepEqual(await permissions(), facts.permissions)
    facts.restored = { values: await allValues(), notification, toolbar: actualToolbar, rail: await railUI() }
    await showSettings(true); await section(probe, 'Copy Paths', 'copy-paths')
  }

  async function capture(target = probe) {
    return target.cdp.evaluate(`(() => {
      const notification=document.querySelector('[data-settings-pane="notifications"]'), toolbar=document.querySelector('.browser-tools-preferences'), rail=document.querySelector('.project-rail')
      return {notification:notification?{visible:notification.getClientRects().length>0,
        index:Number(notification.querySelector('[aria-label="Notification dwell"]').value),sound:notification.querySelector('.notification-sound-toggle input').checked,
        soundDisabled:notification.querySelector('.notification-sound-toggle input').disabled,alert:notification.querySelector('[role="alert"]')?.textContent??''}:null,
        toolbar:toolbar?{items:Array.from(toolbar.querySelectorAll('label')).map(e=>({label:e.querySelector('span').textContent,checked:e.querySelector('input').checked})),
          saveDisabled:toolbar.querySelector('button').disabled,saveText:toolbar.querySelector('button').textContent.trim(),alert:toolbar.querySelector('[role="alert"]')?.textContent??''}:null,
        rail:rail?{density:rail.dataset.railDensity??'default',visible:rail.getClientRects().length>0}:null}
    })()`)
  }

  return { initialize, exercise, verifyRestart, capture, facts }
}
