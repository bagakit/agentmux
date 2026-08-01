# Terminal HTTP link boundary

状态：approved

## 用户原话

> 中文符号和链接连起来，会被识别到一起。测试集加上同时修复。

## 目标

终端里的裸文本 HTTP(S) URL 只覆盖 URL 自身。紧邻其后的中文正文和中文标点不属于
链接，不应被下划线、悬停预览或目的地菜单一起带走；合法的 ASCII URL 路径、查询和片段
仍须完整保留。OSC 8 超链接继续使用它声明的范围，不套用裸文本扫描规则。

## 边界与实现决策

- 规则归 `WebLinksAddon` 的裸 URL provider；不改 xterm 内建 OSC 8 provider，也不复制第二个
  点击出口。
- 复用 xterm 的严格 URL 形状，并在匹配字符集的中间和末尾排除 CJK 文字与 CJK 标点。
- 不为文字路径猜测新的 Unicode URL 规范；literal CJK 字符保持普通终端文本，百分号编码的
  ASCII URL 仍照常识别。
- 测试直接检查匹配出来的链接文本和起始位置，覆盖中文正文、中文标点、ASCII 查询/片段、
  以及 OSC 8 配置不受影响。故意去掉 CJK 边界后，回归测试必须变红。

## 验收

一个纯函数/正则行为测试证明：

1. `https://example.test/a?q=1#part中文。` 的裸 URL 结果严格是
   `https://example.test/a?q=1#part`；
2. URL 前后紧贴中文正文时，中文不在匹配文本里，后续普通文字也不会成为链接；
3. URL 内的 ASCII `?`, `&`, `=`, `%E4%B8%AD` 等仍完整保留；
4. 现有 `WebLinksAddon` 与 OSC 8 共享 `activateHttpLink` 的接线不回退。
