---
tag: agent-source
form: prompt
title: Agent source and handoff
description: A new task or the reading context retained from an original Agent.
examples:
  - label: Take over original work
    template: takeover
  - label: Original Session route
    template: session
    parameters:
      host: local
      session: SESSION
---
# Agent source and handoff

## takeover

~~~text
Take over the original Agent's unfinished work. Establish the user's goal, verified results and open items from the original records, then continue the relevant work.
~~~

## session

~~~text
Read Host: {{host}}
Original Agent Session: {{session}}
~~~

## native

~~~text
Read Host: {{host}}
Original Executor: {{executor}}
Original Provider: {{provider}}
Original Provider Session: {{session}}
Original execution directory: {{directory}}
{{locator}}
~~~

## separate-native

~~~text
Independent saved Provider conversation, if relevant. Usage: {{entry}}.
{{source}}
~~~

## unrouted

~~~text
The original source route is unconfirmed from this Core. Original Host: {{host}}. Original source: {{source}}.
{{diagnostic}}
~~~

## history

~~~text
One bounded history page from the original owner. Continue its cursor only at that owner or through a verified route.
{{page}}
~~~

## native-locator

~~~text
Original Provider locator revision: {{revision}}
Original transcript path: {{transcript}}
~~~
