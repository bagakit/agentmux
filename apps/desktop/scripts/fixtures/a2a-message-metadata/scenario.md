# A2A 时间与通知模式

复用 [原信主阅读](../a2a-primary-reading/scenario.md) 的私有 Electron、三个真实产品消费者、源码绑定与原生输入采图，不引入新的产品 owner 或模拟通知事实。

`verify-a2a-message-metadata.mjs --behavior` 通过实际 journal 的 prepare/result 产生 idle、steer、历史缺时间与 unconfirmed，再经 Core public Reader 生成场景。较新的 steer 通知同时保留，卡片必须仍读 captured 原 notification ID。历史场景从独立旧 journal 导入，保留原身份、模式、结果并缺省时间；unconfirmed 没有已采纳 native input，不能由矛盾 fixture 伪造未知。

`--prepare` 使用原 capture 的 metadata 参数，三个消费者各拍深色正常宽（idle）、深色窄宽（steer）、浅色正常宽（历史缺时间）、浅色窄宽（unconfirmed），另在深色窄宽用原生指针打开 Info，共 15 图。时间、模式、Session ID、正文、详情、窄宽换行和明暗可读性须由独立 Agent 逐张实际看图。未知状态的只读核对与失败保全文字由 mounted shared tests 覆盖；采图不会发送 A2A 或触及用户 Session。

`--acceptance` 最后检查同候选行为、关键真实实现变异、实际 Renderer 文件和完整独立图审；历史 receipt 或未看图的签字不能通过。本证明不覆盖安装包、真实模型采用或 Session 重启。
