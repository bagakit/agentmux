# AgentMux config data durability E2E review

状态：approved

本轮用户确认的发布要求是：版本升级不得静默丢失 authored Host。`local` 只是运行时
默认 Host，不能用回填它掩盖 authored Host 全部解析失败；这种情况必须拒绝启动并保留
原配置。验收以 focused regression 为准：逐个破坏 authored Host 后，测试必须看见拒绝，
而不是只剩 `local` 继续运行。
