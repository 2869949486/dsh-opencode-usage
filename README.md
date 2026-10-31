# OpenCode Go 用量（设置页 + 数据接口）

按模型统计 OpenCode Go 套餐的用量与剩余额度。一个 bundle 同时提供两半：

- **客户端**：设置 → 「OpenCode 用量」页面（`settings.section` 槽位），60 秒自动刷新，右上角「立即刷新」。
- **Host**：`GET /opencode-usage.json`（设置页的数据源；`?refresh=1` 会先强制拉一次官方额度快照）。

网页版已按需求移除，只保留数据接口。

## 数据来源

OpenCode 官方 `/inference/go/v1/usage` 只返回一组四舍五入的 rolling/weekly/monthly 百分比，
不区分模型；而套餐实际是**按模型**各自计额度（5 小时 = 月额度 20%、周 = 50%、月 = 100%）。
所以按模型的数据由本插件自己算：

1. 启动时回扫 `$DSH_HOME/sessions` 下近 40 天的会话日志，取每条 `assistant/message` 的
   `usage` 与 `message.source`（时间用事件自带的 `time`）。
2. 之后实时监听 `session/event`，同一套 reducer 折进内存记录。
3. 金额按内置价格表（离峰/标准价）估算，DeepSeek 模型峰时（UTC 周一至周五 01–04、06–10）乘 2；
   免费模型价格为 0。
4. 窗口起点优先用官方 `resetsAt` 反推，monthly 用 UTC 月初。

## 套餐适配

`cordis.patch.yml` 的 `plan` 决定各模型的月额度表：`go`（默认）/ `go-plus` / `go-teams`。
升级后只有额度差 ≥1.5× 的明确变化（如 go → go-plus）会被官方百分比自动识别；
Go $100 与 Go Teams $105 只差 5%，在估算噪声内，以配置为准。

## 局限

- 只统计**这个 harness** 发出的调用；OpenCode 官方客户端等其它工具不计入。
- 金额是估算；官方百分比只有一行，无法按模型拆分，页面把它原样展示作为交叉核对。
- 数据接口只监听回环地址；插件路由本身不做鉴权。
