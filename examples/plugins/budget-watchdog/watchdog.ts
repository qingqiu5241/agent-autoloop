// 预算守卫：一个不在中台进程里的普通程序，轮询 /v1/state 的花费，超过本人定的线就停下当天的活并通知。
// 它不改内核、不装进 plugins/（那三个口子是 Agent/通道/事件用的），就是一个普通的命令行客户端。
// 要两把密钥：本人的（停下轮次），一个来源的（发通知；rules.json 的 sources 里登记它，比如
// "watchdog": { "name": "预算守卫" }，agent-autoloop key new source watchdog 拿密钥）。
// 用 cron 或 systemd timer 每几分钟跑一次：
//   node examples/plugins/budget-watchdog/watchdog.ts <中台地址> <本人密钥> <来源密钥> [配置文件]
// 配置（JSON，可省略，省略的项用默认）：{ "dayCost": 20, "dayTokens": 20000000 }
"use strict";
import { readFileSync } from "node:fs";

type Spending = { rounds: number; tokens: number; cost: number; missingTokens: number; missingCost: number };
type State = {
  now: string;
  timezone: string;
  spending: { today: Spending; week: Spending };
  runs: { id: number; state: string }[];
};

const DEFAULTS = { dayCost: 20, dayTokens: 20_000_000 };

/** The day in the hub's own time zone: spending is tallied that way, so the once-a-day key must match it. */
function dayOf(state: State) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: state.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(state.now));
  return parts.replaceAll("-", "");
}

async function main() {
  const [url, ownerKey, sourceKey, configFile] = process.argv.slice(2);
  if (!url || !ownerKey || !sourceKey) {
    console.error("用法：watchdog.ts <中台地址> <本人密钥> <来源密钥> [配置文件]");
    process.exit(2);
  }
  const limits = configFile ? { ...DEFAULTS, ...JSON.parse(readFileSync(configFile, "utf8")) } : DEFAULTS;

  const call = async (path: string, key: string, body?: unknown) => {
    const response = await fetch(url.replace(/\/$/, "") + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${key}`, ...(body !== undefined && { "content-type": "application/json" }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  };

  const state = (await call("/v1/state", ownerKey)) as State;
  const { today } = state.spending;
  const reasons: string[] = [];
  if (today.cost >= limits.dayCost) reasons.push(`今天花了 $${today.cost.toFixed(2)}（线是 $${limits.dayCost}）`);
  if (today.tokens >= limits.dayTokens) reasons.push(`今天用了 ${today.tokens} tokens（线是 ${limits.dayTokens}）`);
  if (!reasons.length) return; // 还在线内，没什么要说。

  // 超线：把还在跑和排队的都停下（做完的不动，钱已经花了）。
  const stopped: number[] = [];
  for (const run of state.runs) {
    if (!["queued", "claimed", "unknown"].includes(run.state)) continue;
    try {
      await call(`/v1/runs/${run.id}/cancel`, ownerKey, {});
      stopped.push(run.id);
    } catch (error) {
      console.error(`停 ${run.id} 没成：${error}`);
    }
  }
  const day = dayOf(state);
  await call("/v1/tell", sourceKey, {
    key: `budget-${day}`,
    text: `今天的预算用完了：${reasons.join("；")}。停了 ${stopped.length} 个没跑完的轮次（${
      stopped.length ? stopped.join("、") : "没有在跑的"
    }）。想继续就调高线，或等明天自动恢复。`,
  });
  console.log(`超线：${reasons.join("；")}；停了 ${stopped.length} 个轮次。`);
}

main().catch((error) => {
  console.error(`预算守卫没跑成（下次再试）：${error}`);
  process.exit(1);
});
