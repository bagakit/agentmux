import { useId, useState } from 'react'
import roleTeam from '@agentmux/client-ui/brand/illustrations/mote-origin/role-team.png'
import topicWork from '@agentmux/client-ui/brand/illustrations/mote-origin/topic-work.png'
import grownTeam from '@agentmux/client-ui/brand/illustrations/mote-origin/grown-team.png'

const chapters = [
  {
    label: 'Build from a profile', path: 'From a profile', organization: 'Mote · A team with a shared identity',
    title: 'Bring your specialties together.',
    description: 'Know the expertise you need? Create a Mote from a profile such as PMO, then let its Agents share the work.',
    continuity: 'The team shares a name and style. Each Agent takes on its own work.',
    image: roleTeam,
    alt: 'Blue, amber and violet Agents bring charts, writing and observation into one team profile.',
  },
  {
    label: 'Start with a Topic', path: 'Grow from the work · Start', organization: 'Topic · A direction for your work',
    title: 'Start with something you work on together.',
    description: 'For a new direction, start a Topic. Its Agents build experience and find their roles through real tasks.',
    continuity: 'Start with shared work. Discover which capabilities are worth developing together.',
    image: topicWork,
    alt: 'Three Agents gather sources, charts and notes around a shared Topic workbench.',
  },
  {
    label: 'Promotion', path: 'Grow from the work · Promotion', organization: 'Mote · A lasting collaborator',
    title: 'Let important work become a lasting collaborator.',
    description: 'When a Topic becomes important and useful, promote it to a Mote with a team identity. Keep the same Agents and their accumulated work.',
    continuity: 'Members keep growing in their specialties and can take on coordination over time.',
    image: grownTeam,
    alt: 'The same three Agents carry their expertise and sources forward as their Topic grows into a Mote.',
  },
] as const

export function MoteOriginStory() {
  const [selected, setSelected] = useState(0)
  const id = useId()
  const chapter = chapters[selected]!
  return <section className="mote-origin" aria-labelledby={`${id}-title`}>
    <header className="mote-origin__heading">
      <h3 id={`${id}-title`}>Where collaborators begin</h3>
      <span>Two paths to growing together</span>
    </header>
    <div className="mote-origin__choices" aria-label="How collaborators begin">
      <div className="mote-origin__path"><small>From a profile</small>
        <button type="button" aria-pressed={selected === 0} aria-controls={`${id}-chapter`} onClick={() => setSelected(0)}>{chapters[0].label}</button>
      </div>
      <div className="mote-origin__path"><small>Grow from the work</small>
        {[1, 2].map(index => <button type="button" key={index} aria-pressed={selected === index} aria-controls={`${id}-chapter`} onClick={() => setSelected(index)}>{chapters[index]!.label}</button>)}
      </div>
    </div>
    <div className="mote-origin__chapter" id={`${id}-chapter`} aria-live="polite" aria-atomic="true">
      <div className="mote-origin__copy">
        <span className="mote-origin__eyebrow">{chapter.path}</span>
        <h4>{chapter.title}</h4>
        <p>{chapter.description}</p>
        <p className="mote-origin__continuity">{chapter.continuity}</p>
      </div>
      <figure className="mote-origin__figure">
        <img src={chapter.image} alt={chapter.alt} width="1536" height="1024" />
        <figcaption><strong>{chapter.organization}</strong><span>Agents · Work, learn and grow</span></figcaption>
      </figure>
    </div>
    <p className="mote-origin__note">An illustrated guide: Topics and Motes organize collaboration. Their Agents do the work.</p>
  </section>
}
