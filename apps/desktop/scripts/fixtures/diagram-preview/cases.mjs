const original = `flowchart TD
 A[人物状态：年龄、国家、家庭、教育、职业、资产] --> B[筛选符合条件的事件和决策]
 B --> C[按年份、优先级和权重安排事件]
 C --> D[发生事件或等待玩家选择]
 D --> E[执行结果，更新属性和经历标记]
 E --> F[年度结算，进入下一年]
 F --> A`
const wide = 'flowchart LR\n' + Array.from({ length: 12 }, (_, i) => `N${i}[Step ${i + 1}]`).join(' --> ')
const model = label => `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="${label}" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc" vertex="1" parent="1"><mxGeometry x="12" y="12" width="180" height="70" as="geometry"/></mxCell></root></mxGraphModel>`
const drawio = `<mxfile><diagram name="First">${model('First page')}</diagram><diagram name="Second">${model('Second page')}</diagram></mxfile>`
export const cases = [
  { name: 'Mermaid · 六步年度循环', slug: 'mermaid-original-light', language: 'mermaid', code: original, theme: 'light', width: 1100, height: 860, interact: true, labels: ['人物状态', '年度结算'] },
  { name: 'Mermaid · 六步年度循环', slug: 'mermaid-original-dark', language: 'mermaid', code: original, theme: 'dark', width: 1100, height: 860 },
  { name: 'Mermaid · 窄窗', slug: 'mermaid-narrow', language: 'mermaid', code: original, theme: 'dark', width: 390, height: 650, interact: true },
  { name: 'Mermaid · 低窗', slug: 'mermaid-short', language: 'mermaid', code: original, theme: 'light', width: 1000, height: 400 },
  { name: 'Mermaid · 宽图', slug: 'mermaid-wide', language: 'mermaid', code: wide, theme: 'light', width: 1000, height: 760, interact: true },
  { name: 'DOT · 纵向流程', slug: 'dot-tall', language: 'dot', code: 'digraph { rankdir=TB; node [shape=box]; ' + Array.from({ length: 12 }, (_, i) => `N${i}`).join(' -> ') + '; }', theme: 'dark', width: 1000, height: 760, interact: true, labels: ['N0', 'N11'] },
  { name: 'DOT · 横向流程', slug: 'dot-wide', language: 'gv', code: 'digraph { rankdir=LR; node [shape=box]; ' + Array.from({ length: 12 }, (_, i) => `N${i}`).join(' -> ') + '; }', theme: 'light', width: 1000, height: 760 },
  { name: 'draw.io · 原尺寸小图与多页', slug: 'drawio-small', language: 'drawio', code: drawio, theme: 'light', width: 1000, height: 760, labels: ['First page'], nextPage: true, small: true },
  { name: 'PlantUML · 时序图', slug: 'plantuml-sequence', language: 'plantuml', code: '@startuml\nAlice -> Bob : Review current draft\nBob --> Alice : Accepted\n@enduml', theme: 'dark', width: 1000, height: 760, labels: ['Review current draft'] }
]
