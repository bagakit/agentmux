import assert from 'node:assert/strict'
const incoming = ".log-turn:not([data-compact='true']):is([data-speaker-role='human'], [data-speaker-role='external'], [data-speaker-relation='other-agent'])"
export const messageSlotMutations = ['incoming-slot-scope', 'progress-body-scope', 'system-body-scope']
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
    if (name === 'incoming-slot-scope') {
      const prefix = incoming + ' > ', count = rule.selector.split(prefix).length - 1
      if (count) { rule.selector = rule.selector.replaceAll(prefix, incoming + ' '); changes += count }
    } else if (normalize(rule.selector) === normalize(from.slice(0, -2))) {
      rule.selector = to.slice(0, -2); changes++
    }
  })
  if (name === 'incoming-slot-scope') assert.ok(changes >= 5, 'The original incoming slot rules are present')
  else assert.equal(changes, 1, 'One original variant body rule is present')
  return changes
}
