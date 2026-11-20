---
tag: amux:ref
form: envelope
title: Focus selection reference
description: The exact Focus scope and selection. Read the selected members with the CLI entry.
  An explicit all selection means every member in that scope. An unconfirmed selection needs the original scope or members.
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

## project

~~~text
项目 Space ID：{{project}}（Host：{{host}}）
~~~

## collection

~~~text
Collection 类别 Space ID：{{categories}}（Host：{{host}}）
~~~

## selection

~~~text
{{group}}
所选 Focus 成员：{{members}}
~~~

## all

~~~text
全组
~~~

## empty

~~~text
无
~~~

## unknown

~~~text
未确认
~~~
