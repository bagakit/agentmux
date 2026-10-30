import { useId, useState } from 'react'
import roleTeam from '../../assets/mote-origin/role-team.png'
import topicWork from '../../assets/mote-origin/topic-work.png'
import grownTeam from '../../assets/mote-origin/grown-team.png'
import '../../styles/mote-origin-story.css'

const chapters = [
  {
    label: '按画像组建', path: '画像创建', organization: 'Mote · 有人格的团队',
    title: '带着专长，开始合作。',
    description: '已经知道需要什么？从 PMO 这样的专家画像建立 Mote，让其中的 Agent 分工，把事情一起做好。',
    continuity: '团队有共同的名字与风格，成员各自承担工作。',
    image: roleTeam,
    alt: '蓝色、琥珀色和紫色的三位 Agent 把图表、书写和观察三种专长拼入共同的团队画像。',
  },
  {
    label: '从 Topic 开始', path: '从事情成长 · 开始', organization: 'Topic · 一个工作方向',
    title: '从每天一起做的一件事开始。',
    description: '方向还新，就先建一个 Topic。让其中的 Agent 从具体任务开始，在一次次合作中积累经验、形成分工。',
    continuity: '先有一起做的事，再发现值得长期发展的能力。',
    image: topicWork,
    alt: '三位 Agent 围绕同一个 Topic 工作台，汇集资料、图表和笔记，形成共同的上下文。',
  },
  {
    label: 'Promotion', path: '从事情成长 · Promotion', organization: 'Mote · 长期伙伴',
    title: '让重要的方向，成为长期伙伴。',
    description: '当一个 Topic 足够重要、被频繁依赖，就让它晋升为 Mote，建立团队人格。原来的 Agent 与积累一起延续。',
    continuity: '成员继续成长：深耕专业，也可以逐渐承担协调。',
    image: grownTeam,
    alt: '三位原 Agent 带着自己的专长与资料，站在连续的团队平台上；积累的 Topic 核心展开为 Mote 人格。',
  },
] as const

export function MoteOriginStory() {
  const [selected, setSelected] = useState(0)
  const id = useId()
  const chapter = chapters[selected]!
  return <section className="mote-origin" aria-labelledby={`${id}-title`}>
    <header className="mote-origin__heading">
      <h3 id={`${id}-title`}>伙伴从哪里来</h3>
      <span>两条路径，一起成长</span>
    </header>
    <div className="mote-origin__choices" aria-label="伙伴来源故事">
      <div className="mote-origin__path"><small>画像创建</small>
        <button type="button" aria-pressed={selected === 0} aria-controls={`${id}-chapter`} onClick={() => setSelected(0)}>{chapters[0].label}</button>
      </div>
      <div className="mote-origin__path"><small>从事情成长</small>
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
        <figcaption><strong>{chapter.organization}</strong><span>内部 Agent · 做事、积累、成长</span></figcaption>
      </figure>
    </div>
    <p className="mote-origin__note">故事示意 · Topic / Mote 承载协作，Agent 是其中实际做事的成员。</p>
  </section>
}
