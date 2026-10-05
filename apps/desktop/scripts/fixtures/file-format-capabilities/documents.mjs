import { fixtureClock as _hygiene_fixtureClock } from "../../lib/fixture-values.mjs"
const model = label => `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="${label}" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#507891" vertex="1" parent="1"><mxGeometry x="40" y="40" width="240" height="90" as="geometry"/></mxCell></root></mxGraphModel>`
const base = { angle: 0, strokeColor: '#507891', backgroundColor: '#dae8fc', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: { type: 3 }, seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false }
export function documents(attackUrl) {
  return {
    'notes.md': '# Workspace notes\n\nKeep the source close to the result.\n\n## Release checks\n\n- Read the draft\n- Inspect the preview\n- Keep the original identity\n\n```javascript\nconst ready = true;\n```\n\nThe inline formula $a^2+b^2=c^2$ and display equation:\n\n$$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$\n\n```mermaid\nflowchart LR\nDraft --> Review --> Ready\n```\n',
    'records.jsonl': '{"name":"Atlas","count":9223372036854775807,"ready":true}\n{broken}\n{"name":"Boreal","count":24,"ready":false}\n',
    'settings.yaml': '# Service configuration\nname: Atlas\nenabled: true\nlimits:\n  workers: 2\n  retry: 3\n---\nname: Boreal\nenabled: false\n',
    'settings.toml': ("name = \"Atlas\"\nenabled = true\ncount = 9223372036854775807\nwhen = " + _hygiene_fixtureClock(7, 32, 0, 123456789, 9) + "\n[limits]\nworkers = 2\nretry = 3\n"),
    'measurements.csv': 'name,month,revenue,ready\nAtlas,January,120,true\nBoreal,February,180,false\nCedar,March,240,true\n',
    'lookup.tsv': 'name\tvalue\nAtlas\t12\nBoreal\t24\n',
    'preferences.json': '{"theme":"graphite","editor":{"fontSize":14,"wordWrap":true},"workspaces":["Atlas","Boreal"]}',
    'format.js': 'const result={ready:true,items:[1,2,3]};\n',
    'diagram.mmd': 'flowchart LR\nDraft[Current source] --> Review{Review}\nReview -->|ready| Preview[Inline preview]\nReview -->|changes| Draft\n',
    'graph.dot': 'digraph Workflow { rankdir=LR; node [shape=box, style="rounded,filled", fillcolor="#dae8fc"]; Draft -> Review -> Preview; Review -> Draft [label="changes"]; }',
    'drawing.drawio': `<mxfile><diagram name="Overview">${model('Current workspace draft')}</diagram><diagram name="Details">${model('Second page')}</diagram></mxfile>`,
    'sequence.puml': '@startuml\nAlice -> Bob : Review current draft\nBob --> Alice : Preview ready\n@enduml',
    'scene.excalidraw': JSON.stringify({ type: 'excalidraw', version: 2, source: 'private-fixture', elements: [
      { ...base, id: 'draft', type: 'rectangle', x: 30, y: 30, width: 220, height: 100 },
      { ...base, id: 'preview', type: 'ellipse', x: 320, y: 30, width: 160, height: 100, backgroundColor: '#dbeddf' }
    ], appState: { viewBackgroundColor: '#ffffff' }, files: {} }),
    'chart.vega': JSON.stringify({ $schema: 'https://vega.github.io/schema/vega/v6.json', width: 420, height: 220, padding: 20,
      signals: [{ name: 'level', value: 1, bind: { input: 'range', min: 1, max: 3, step: 1 } }],
      data: [{ name: 'table', url: 'measurements.csv', format: { type: 'csv', parse: { revenue: 'number' } } }],
      scales: [{ name: 'x', type: 'band', domain: { data: 'table', field: 'name' }, range: 'width', padding: .2 }, { name: 'y', domain: [0, 300], range: 'height', nice: true }],
      axes: [{ orient: 'bottom', scale: 'x' }, { orient: 'left', scale: 'y' }], marks: [{ type: 'rect', from: { data: 'table' }, encode: { enter: { x: { scale: 'x', field: 'name' }, width: { scale: 'x', band: 1 }, y: { scale: 'y', field: 'revenue' }, y2: { scale: 'y', value: 0 }, fill: { value: '#507891' } } } }] }),
    'chart.vl': JSON.stringify({ $schema: 'https://vega.github.io/schema/vega-lite/v6.json', width: 420, height: 220,
      data: { values: [{ name: 'Atlas', value: 12 }, { name: 'Boreal', value: 24 }, { name: 'Cedar', value: 18 }] }, mark: { type: 'bar', color: '#507891' }, encoding: { x: { field: 'name', type: 'nominal' }, y: { field: 'value', type: 'quantitative' } } }),
    'analysis.ipynb': JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { name: 'python3', language: 'python', display_name: 'Python 3' } }, cells: [
      { cell_type: 'code', id: 'static-result', metadata: {}, execution_count: 3, source: ['result = {"ready": True, "count": 24}\nresult'], outputs: [
        { output_type: 'display_data', metadata: {}, data: { 'text/html': `<h2>Static result</h2><p>The draft stays editable.</p><script>document.body.dataset.scriptRan='yes';window.__notebookAttack=1;fetch('${attackUrl}')</script><img src="${attackUrl}" onerror="document.body.dataset.scriptRan='yes'"><style>@import '${attackUrl}';</style>`, 'text/plain': 'Static result' } },
        { output_type: 'display_data', metadata: {}, data: { 'image/svg+xml': `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="100" onload="window.__notebookAttack=3"><script>window.__notebookAttack=4;fetch('${attackUrl}')</script><image href="${attackUrl}"/><rect x="12" y="12" width="360" height="70" rx="8" fill="#dae8fc"/><text x="30" y="54" fill="#304a60">Local SVG result</text></svg>` } }
      ] },
      { cell_type: 'markdown', id: 'notes', metadata: {}, source: ['## Notes\n\nRead-only cells keep the full notebook source.'], attachments: {} },
      ...Array.from({ length: 10 }, (_, index) => ({ cell_type: 'raw', id: `raw-${index}`, metadata: {}, source: [`Original raw cell ${index + 1}\nRead-only source remains in the notebook.`] }))
    ] }),
    'document.tex': '\\documentclass{article}\n\\begin{document}\nSAVED TEX SOURCE\n\\input{sibling.tex}\n\\end{document}\n',
    'sibling.tex': 'LOCAL TEX RESOURCE',
    'document.typ': '= Saved Typst source\n\nSAVED TYPST SOURCE\n\n#include "sibling.typ"\n',
    'sibling.typ': 'LOCAL TYPST RESOURCE',
    'index.html': '<!doctype html><html><head><link rel="stylesheet" href="preview.css"></head><body><h1>Workspace preview</h1><p>Current source renders in this File.</p><button id="increment">Run interaction</button><output id="count">0</output><script type="module" src="behavior.mjs"></script></body></html>',
    'preview.css': 'body{font:16px system-ui;padding:32px;background:#f6f8fa;color:#304a60}button{padding:12px;background:#dae8fc;border:1px solid #507891;border-radius:6px}output{padding:12px}',
    'behavior.mjs': 'let count=0;document.querySelector("#increment").onclick=()=>document.querySelector("#count").textContent=String(++count);',
    'drawing.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="420" height="160"><rect x="20" y="20" width="360" height="100" rx="12" fill="#dae8fc"/><text x="40" y="75" font-size="22" fill="#304a60">Current SVG source</text></svg>'
  }
}
