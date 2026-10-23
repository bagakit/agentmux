import assert from 'node:assert/strict'
const incoming = ".log-turn:not([data-compact='true']):is([data-speaker-role='human'], [data-speaker-role='external'], [data-speaker-relation='other-agent'])"
export const messageSlotMutations = ['incoming-slot-scope', 'progress-body-scope', 'system-body-scope', 'identity-no-wrap', 'fixed-header-columns']
export function mutateMessageSlotScope(styles, name, owner) {
  assert.ok(messageSlotMutations.includes(name), 'Known slot-boundary mutation')
  const from = name === 'progress-body-scope'
    ? ".log-turn[data-message-phase='progress'] > .log-turn__body,\n.log-turn[data-message-phase='progress'] > .message-disclosure > .message-disclosure__body > .log-turn__body,\n.log-turn[data-message-phase='progress'] > .log-turn__system-body > .log-turn__body,\n.log-turn[data-message-phase='progress'] > .log-turn__collaboration-content > .log-turn__body {"
    : ".log-turn[data-speaker-role='system'] > .log-turn__system-body > .log-turn__body {"
  const to = name === 'progress-body-scope'
    ? ".log-turn[data-message-phase='progress'] .log-turn__body {"
    : ".log-turn[data-speaker-role='system'] .log-turn__body {"
  const normalize = selector => selector.replace(/\s+/gu, ' ').trim()
  let changes = 0
  styles.walkRules(rule => {
    if (rule.source?.input.file?.split('?')[0] !== owner) return
    if (name === 'fixed-header-columns') {
      if (rule.selector === '.log-turn__head') {
        rule.walkDecls('display', declaration => {
          assert.equal(declaration.value, 'flex')
          declaration.value = 'grid'
          rule.append({ prop: 'grid-template-columns', value: 'minmax(0, 1fr) auto auto auto' })
          changes++
        })
      } else if (rule.selector === '.log-turn__head > .conversation-input-details > .conversation-input-details__body') {
        rule.append({ prop: 'grid-column', value: '1 / -1' })
        changes++
      }
    } else if (name === 'identity-no-wrap') {
      if (rule.selector === '.log-turn__sender-id') {
        rule.walkDecls('flex-wrap', declaration => { assert.equal(declaration.value, 'wrap'); declaration.value = 'nowrap'; changes++ })
      }
    } else if (name === 'incoming-slot-scope') {
      const prefix = incoming + ' > ', count = rule.selector.split(prefix).length - 1
      if (count) { rule.selector = rule.selector.replaceAll(prefix, incoming + ' '); changes += count }
    } else if (normalize(rule.selector) === normalize(from.slice(0, -2))) {
      rule.selector = to.slice(0, -2); changes++
    }
  })
  if (name === 'fixed-header-columns') assert.equal(changes, 2, 'Restore the original fixed columns and their full-width details placement')
  else if (name === 'incoming-slot-scope') assert.ok(changes >= 5, 'The original incoming slot rules are present')
  else assert.equal(changes, 1, 'One original variant body rule is present')
  return changes
}
