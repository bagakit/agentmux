import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const renderer = join(import.meta.dirname, '../src/renderer/src')
const activity = readFileSync(join(renderer, 'components/ProjectActivity.tsx'), 'utf8')
const sidebar = readFileSync(join(renderer, 'components/WorkspaceSidebar.tsx'), 'utf8')
const styles = readFileSync(join(renderer, 'styles/chrome.css'), 'utf8')

describe('Project tree status slot contract', () => {
  it('scans non-empty production sources and one shared metric structure', () => {
    expect(activity.length).toBeGreaterThan(500)
    expect(sidebar.length).toBeGreaterThan(500)
    expect(styles.length).toBeGreaterThan(10_000)
    expect(activity).toContain('project-activity__metrics')
    expect(activity).toContain('project-activity__metric')
    expect(sidebar).toContain('<ProjectActivity')
  })

  it('projects working, idle, needs-you, and error into the same icon-plus-number slots', () => {
    for (const key of ['needs-you', 'error', 'working', 'idle']) {
      expect(activity).toContain(`key: '${key}'`)
      expect(styles).toContain(`.project-activity__metric--${key}`)
    }
    expect(activity).toContain(".filter((metric) => metric.count > 0)")
    expect(activity).toContain('SemanticIcon name={metric.icon}')
    expect(sidebar).not.toContain('className="project-rail-row__activity"')
  })

  it('keeps complete names in the accessible label and removes the old text expansion path', () => {
    expect(activity).toContain('aria-label={`${metricLabel}. ${details}`}')
    expect(activity).not.toContain('project-activity__label')
    expect(styles).not.toContain('project-activity__label')
  })
})
