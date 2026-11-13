/** Presentation oracles from the Settings SSOT, not a product score or a business-state check. */
export const dimensions = ['first-screen', 'type', 'language', 'jargon']
export const archetypes = ['preference', 'library', 'console', 'reference']

export function selectSections(registered, requested) {
  if (!registered.length || new Set(registered.map(item => item.id)).size !== registered.length) throw new Error('The registered Settings sections must be nonempty and unique.')
  for (const item of registered) if (!archetypes.includes(item.archetype)) throw new Error(`Missing or invalid archetype: ${item.id}`)
  const selected = requested ?? registered.map(item => item.id)
  if (!selected.length || new Set(selected).size !== selected.length) throw new Error('Select at least one unique Settings section.')
  for (const id of selected) if (!registered.some(item => item.id === id)) throw new Error(`Unknown Settings section: ${id}`)
  return registered.filter(item => selected.includes(item.id))
}

export function presentationIssues(section, facts, viewport) {
  const issues = []
  const add = (dimension, message, evidence) => issues.push({ dimension, message, evidence })
  if (['preference', 'console'].includes(section.archetype) && viewport.width === 1280 && viewport.height === 860) {
    if (facts.firstControl === null) add('first-screen', 'No enabled control was rendered.', null)
    else if (facts.firstControl.top > facts.clientHeight / 3) add('first-screen', 'The first control is below the first third of the pane.', facts.firstControl)
    if (facts.introductionHeight > 160) add('first-screen', 'Concept and brand introductions exceed 160px.', facts.introductions)
  }
  if (facts.overflowX) add('first-screen', 'The page overflows horizontally.', true)
  if (facts.smallBody.length) add('type', 'Paragraph text is smaller than the body token.', facts.smallBody)
  if (facts.bodyFontSizes.length > 4) add('type', 'Body and heading text use more than four size tiers.', facts.bodyFontSizes)
  if (facts.cjk.length) add('language', 'English UI text contains CJK characters.', facts.cjk)
  if (facts.jargon.length) add('jargon', 'UI prose uses implementation terms outside diagnostics.', facts.jargon)
  return issues
}

export function validateCapture(report, selected, variants) {
  if (!report.rows?.length) throw new Error('The Renderer produced no Settings measurements.')
  const expected = selected.length * variants.length
  if (report.rows.length !== expected) throw new Error(`Expected ${expected} section measurements; received ${report.rows.length}.`)
  for (const section of selected) for (const variant of variants) {
    const rows = report.rows.filter(row => row.section === section.id && row.mode === variant.mode && row.viewport.width === variant.width && row.viewport.height === variant.height)
    if (rows.length !== 1 || !['measured', 'state-unavailable'].includes(rows[0].status)) throw new Error(`Missing, duplicated or failed Renderer measurement: ${section.id} / ${variant.mode} / ${variant.width}x${variant.height}`)
    const facts = rows[0].facts
    if (!facts || !Number.isFinite(facts.textLength) || facts.textLength < 1 || !Number.isFinite(facts.clientHeight) || facts.clientHeight <= 0
      || !Number.isFinite(facts.introductionHeight) || !Number.isFinite(facts.bodyToken) || facts.bodyToken <= 0
      || !['bodyFontSizes', 'smallBody', 'cjk', 'jargon', 'introductions', 'saveBars'].every(key => Array.isArray(facts[key]))
      || typeof facts.overflowX !== 'boolean' || !(facts.firstControl === null || Number.isFinite(facts.firstControl?.top))) throw new Error(`Incomplete Renderer metrics: ${section.id}`)
  }
}
