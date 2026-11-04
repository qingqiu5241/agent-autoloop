# 预算守卫（watchdog）

无人值守时唯一的花费护栏：一个不进中台进程的普通程序，每几分钟看一眼 `/v1/state` 的今日花费，
超过你定的线就停掉所有没跑完的轮次，并发一张通知卡。不做别的——线内时一声不吭。

## 为什么是外挂程序

内核刻意没有预算字段（`AGENTS.md`：代码只写现在需要的）。守卫作为一个普通客户端就够：
和 `agent-autoloop status` 是同一种东西，出问题最多是它自己没跑成，伤不到中台。

## 装法

1. 中台侧登记一个来源（发通知用）：

   ```bash
   agent-autoloop key new source watchdog
   ```

   再在 `~/.agent-autoloop/rules.json` 的 `sources` 里加一行（`agent-autoloop check` 检查）：

   ```json
   "watchdog": { "name": "预算守卫" }
   ```

2. 写配置（可省，默认 `dayCost: 20` 美元、`dayTokens: 2000 万`；`cost` 与 `agent-autoloop status` 同口径，单位美元）：

   ```json
   { "dayCost": 20, "dayTokens": 20000000 }
   ```

3. 每 15 分钟跑一次（crontab 示例；systemd timer 同理）：

   ```cron
   */15 * * * * node /path/to/agent-autoloop/examples/plugins/budget-watchdog/watchdog.ts https://127.0.0.1:3350 <本人密钥> <watchdog 来源密钥> /path/to/budget.json
   ```

## 它做什么

- 读 `/v1/state`：`spending.today` 按**规则时区的今天**汇总（跨零点自动清零）。
- 超线时：对每个 `queued`/`claimed`/`unknown` 的轮次调 `/v1/runs/<id>/cancel`（本人密钥），
  然后用 `/v1/tell` 发一张卡（`budget-<规则时区的日期>` 做 key，一天最多打扰一次）。
- 线内：什么都不做，退出码 0。中台不可达：退出码 1，等下一班。做完的轮次不动——钱已经花了。

## 边界（诚实说明）

- 它是抽样的，两班之间跑超的钱拦不住；把间隔调小可以收紧。
- `cancel` 对 `claimed` 的轮次是"等接单程序停"（协议语义），正在跑的 Agent 要等它自己收尾。
- 它不能阻止新事件进来产生新轮次；超线期间新来的活会在下一班被停。要彻底停，把高频规则的 cron 注释掉。
