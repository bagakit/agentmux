---
tag: amux:reaction
form: marker
title: Quick reply
description: A reply keyword. Its meaning belongs to the original selected Prompt snapshot; it does not approve permissions.
examples:
- label: Standalone keyword declaration
  template: wire
  parameters:
    keyword: ok
---

# Quick reply

## wire

~~~text
<amux:reaction {{keyword}} />
~~~

## note

~~~text
{{marker}}
User quick reply snapshot: {{label}}
Original reply source: {{source}}
~~~

## starter-ok

~~~text
我认可这条回复；不额外授权继续执行，也不批准权限请求。
~~~

## starter-continue

~~~text
沿当前已授权的目标继续；保留原范围、权限与确认边界。
~~~

## starter-clarify

~~~text
先解释这条回复的依据和不清楚之处，再等我的决定。
~~~
