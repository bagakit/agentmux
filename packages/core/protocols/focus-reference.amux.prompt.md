---
tag: amux:ref
form: envelope
title: Focus selection reference
description: The exact Focus selection and the CLI help for reading its members.
examples:
- label: Selected members and task
  template: wire
  parameters:
    kind: focus-selection
    entry: focus read --help
    body: '项目 Space ID：PROJECT_ID（Host：local）

      所选 Focus 成员：local/MEMBER_ID'
  after: '


    整理这组工作，给我一份可以逐项决定的清单。'
---

# Focus selection reference

## wire

~~~text
<amux:ref kind="{{kind}}" read-via="{{entry}}">
{{body}}
</amux:ref>
~~~
