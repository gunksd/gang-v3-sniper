# gang-v3-sniper

[gang.fun](https://gang.fun) **LaunchpadV3** 新币狙击器（BNB Chain）。监听 V3 发射台的 `Created` 事件，用你自己的
[币安 Agentic Wallet](https://www.npmjs.com/package/@binance/agentic-wallet) 签名下单，按你选的规则自动卖出。
本程序只组交易数据，签名全部交给 `baw`，不接触私钥。

> **风险提示**：自动交易会真实花钱，新币可能归零，税、手续费和滑点都会吃掉本金。
> 默认 **dry-run**（只记录不下单），确认行为符合预期后再开实盘。本项目与 gang.fun / 币安官方无关，代码未经审计，后果自负。

- [它做什么](#它做什么)
- [准备](#准备)
- [安装](#安装)
- [上手](#上手)
- [买入档位与卖出规则](#买入档位与卖出规则)
- [V3 地址自动发现](#v3-地址自动发现)
- [风控](#风控)
- [命令](#命令)
- [配置](#配置)
- [日志与数据](#日志与数据)
- [常见问题](#常见问题)
- [开发](#开发)

## 它做什么

```
WSS eth_subscribe("logs", { address: LaunchpadV3, topics: [Created] })
        │  topics[1]=新币  topics[2]=创建者  topics[3]=计价币  data.gradAmt
        ▼
本地按合约公式算 quoteIn / minTokensOut（开盘曲线由 gradAmt 唯一确定，不用先查链）
        │
        ├── baw contract-call preview  ─┐  并行
        └── curves(token) 读真实买卖税 ──┘
        ▼
税超上限 / 模拟失败 / 风控要 App 确认 → 放弃；否则 execute
        ▼
回执里读自己的 Buy 事件记仓位 → 每 5 秒按卖出规则检查 → 内盘卖；毕业后去 PancakeSwap 卖
```

- 只订阅 LaunchpadV3 自己的 `Created`，不扫全链日志
- 本地算价移植自合约源码，与 BSC 测试网链上成交**逐 wei 一致**（见 `tests/curve.test.js`）
- 主网 V3 还没上线时也能先挂着：程序会在链上[自动发现](#v3-地址自动发现) V3 地址

### V3 规则（与本程序相关的部分）

| | 内盘（毕业前） | 外盘（毕业后，PancakeSwap） |
|---|---|---|
| 买 | 1% 平台费 + 买税（1%–5%） | 买税 |
| 卖 | 1% 平台费 + 卖税（1%–5%） | 卖税 |

- 内盘只对持有 `.ai` Agent ID 的 Agentic Wallet 开放
- 每个地址最多持有总量的 **1%**
- 募集约 15 BNB 等值后毕业，自动建 PancakeSwap 池子；毕业前代币不能转账

## 准备

- **Node.js 22+**（`node -v` 查看）
- **币安 App → 钱包 → Agentic Wallet**：创建钱包，领取 `.ai` Agent ID
- App 里打开 **Developer Mode** 和 **Trade all tokens**
- 建议把「异常交易处理」改成不需要确认：否则被风控标记的单要你在 App 里点确认，狙击会跳过这类单
- BSC 上的 BNB：开盘买 1% 约 **0.05 WBNB**（2% 买税时），再留一点 gas（每笔约 0.0001 BNB）

## 安装

```bash
# 1. 币安钱包命令行，用你自己的钱包登录
npm i -g @binance/agentic-wallet
baw auth signin

# 2. 本程序
npm i -g github:gunksd/gang-v3-sniper

# 3. 自检
gang-sniper doctor
```

`doctor` 会检查登录状态、Agent ID、App 开关、余额、授权、WSS 连接和 V3 地址，并用中文列出要处理的问题。

**在国内走代理**：设好 `HTTPS_PROXY` 即可，程序会自动让 Node 的网络请求走代理。

```bash
export HTTPS_PROXY=http://127.0.0.1:7890
```

### 用另一个钱包狙击（多钱包）

baw 的会话目录可以用环境变量 `BINANCE_BAW_DIR` 指定，默认 `~/.baw`。每个钱包配一个独立目录和一个包装脚本：

```bash
N=2
PKG=$(cd "$(dirname "$(readlink -f "$(which baw)")")/.." && pwd)
NODE=$(readlink -f "$(which node)")
mkdir -p ~/.baw$N ~/.baw$N-cli/bin && chmod 700 ~/.baw$N
cp -R "$PKG" ~/.baw$N-cli/pkg                    # 固定版本，全局升级不影响
rm -rf ~/.baw$N-cli/pkg/node_modules/@github/keytar   # macOS 必须做，见下
cat > ~/.baw$N-cli/bin/baw <<EOS
#!/bin/bash
export BINANCE_BAW_DIR="\$HOME/.baw$N"
exec "$NODE" "\$HOME/.baw$N-cli/pkg/dist/index.js" "\$@"
EOS
chmod +x ~/.baw$N-cli/bin/baw
~/.baw$N-cli/bin/baw auth signin                  # 扫码登录这个钱包
```

> **为什么要删 keytar**：baw 有系统钥匙串时，会把会话 ID 存进钥匙串里一个**固定的**条目（`baw` / `agentSessionId`），
> 和 `BINANCE_BAW_DIR` 无关。不删的话，登录第二个钱包会覆盖第一个钱包的会话。删掉后 baw 改把会话 ID 加密存在
> `BINANCE_BAW_DIR/session.json`。会话加密密钥由本机 MAC 地址派生，会话目录不能拷到别的机器用。

然后让狙击器用它：`~/.gang-sniper/config.json` 里写 `"bawBin": "~/.baw2-cli/bin/baw"`，或者启动时 `SNIPER_BAW=~/.baw2-cli/bin/baw`。
启动时会先查这个钱包的登录状态，没登录就报错退出，不会退回去用默认钱包。

### 私有 RPC

有 API key 的节点写在 `~/.config/gang-sniper/secrets.json`（不在仓库里，日志里 key 会打码）：

```json
{ "rpc": "https://bnb-mainnet.g.alchemy.com/v2/<你的key>" }
```

- WSS 默认取同一个地址（https→wss），和公共节点同时订阅，谁先到用谁
- 归档节点能查旧日志，V3 自动发现的回溯从约 8 小时扩到约 10 天

## 上手

```bash
gang-sniper config               # 交互选择：买入档位 / 卖出规则 / 计价币 / 税上限 / 滑点 / 限额 / dry-run 或实盘
gang-sniper prepare --wrap 0.3   # 把 0.3 BNB 换成 WBNB（V3 内盘用 WBNB 付款）
gang-sniper run                  # 开始；Ctrl+C 停止
```

建议顺序：

1. `config` 保持 **dry-run**，`run` 挂一段时间，看 `~/.gang-sniper/sniper.log` 里的 `dry_run_buy` 是否符合预期
2. `config` 改成实盘，档位选 **0.25%**，跑通一单
3. 再调到你想要的档位

长期挂着（macOS，崩溃自动重启、防休眠）：

```bash
nohup bin/supervise.sh > /dev/null 2>&1 &      # 在仓库目录里
tail -f ~/.gang-sniper/sniper.log
kill $(cat ~/.gang-sniper/supervise.pid)       # 停止
```

或者用 pm2：

```bash
npm i -g pm2
pm2 start gang-sniper --name sniper -- run
pm2 logs sniper
```

或者 `nohup gang-sniper run >> ~/gang-sniper.out 2>&1 &`。

## 买入档位与卖出规则

### 买入档位

按占总量计算，单地址上限 1%：

| 档位 | 开盘大约花费（2% 买税） |
|---|---|
| `0.25%` | 0.012 WBNB |
| `0.5%` | 0.024 WBNB |
| `0.75%` | 0.037 WBNB |
| `1%` | 0.049 WBNB |

- `Created` 事件不带税率，下单金额按你设的**买税上限**计算；真实税率在预览期间并行读出，超限就不执行
- 选 1% 时会多带滑点余量，合约把超过 1% 上限的部分原路退回；不足 1% 时按目标数量精确付款，`minTokensOut` = 目标 ×（1 − 滑点）

### 固定每笔发送额（多出的退回）

想用「每笔都打固定金额、合约只扣 1% 的实际成本、其余退回」的打法，在配置里写：

```json
{ "size": "1", "buyQuoteIn": { "wbnb": "0.5" }, "maxSpendQuote": { "wbnb": "0.5" } }
```

- 每笔发 0.5 WBNB；开盘时合约只扣约 0.049（2% 买税），退回约 0.451，退回的钱接着打下一个币
- 别人先买、价格涨了也照样买满 1%，最多花到 0.5（大约前面已有 40 个地址买满时，花 0.126）
- 每日预算按实际扣掉的成本算，退回的部分不计入
- 只能配合 `size: 1`：不到 1% 上限时合约不退款，整笔都会拿去买币
- 两个币几秒内接连出现时，第二个会等第一个的退款到账；钱包里多放几笔的量就能同时打
- 实盘下余额不够一笔时，会把 BNB（保留 0.01 作 gas）自动换成 WBNB

### 一个一个打（排队），只打前 N 个

```json
{ "sequential": true, "maxTokens": 10 }
```

- `sequential`：同一时间只有一笔 V3 买单在路上。后面出来的币排队，等前一笔的回执和退款回来再打；排队超过 3 个块的币不追
- `maxTokens`：总共打几个币（跨重启计数），打满就停
- 钱包不够 `buyQuoteIn` 时，发剩下的钱，只要还够开盘价买满 1% 加滑点；不够就跳过

### 卖出规则

| 规则 | 做什么 | 默认止损 | 默认最长持有 |
|---|---|---|---|
| `x2` | 扣除卖出费后值 2 倍，全部卖出 | -50% | 6 小时 |
| `x3` | 扣除卖出费后值 3 倍，全部卖出 | -50% | 6 小时 |
| `ladder` | 2 倍卖 50%，4 倍卖 25%，8 倍卖剩余 | -50% | 12 小时 |
| `progress50` | 内盘进度到 50%，全部卖出 | -50% | 6 小时 |
| `graduate` | 拿到毕业，去 PancakeSwap 卖（只付卖税） | 不止损 | 24 小时 |
| `manual` | 不自动卖，用 `gang-sniper sell` 手动卖 | — | — |

- 倍数、进度、止损百分比、最长持有时间都能在 `config` 里改
- 倍数按「每枚代币」计算，分批卖出后剩余部分的倍数照样可比
- 估值已扣除卖出时的平台费和卖税；毕业后按 PancakeSwap 实际报价估值

## 地址自动发现（V3 + 打新）

主网还没上线时就可以 `run` 挂着。程序同时等两个合约：V3 发射台和打新合约（FairMintPad），各自找到后各自开始。

按 gang 的上线手册（`docs/MAINNET-RUNBOOK-V3-FAIR-2026-10-26.md`），两套合约由一个新的部署钱包发布，接到一个**新的**共用手续费合约上，再转给多签，链上没有能提前认出它们的已知地址。所以信任来源是 gang 自己发布的地址，再到链上核对：

| 来源（任意一个出现即可） | 何时出现 |
|---|---|
| `gang.fun/api/v3/config`、`/api/fair/config` 返回 `enabled: true` | 服务端切到新合约后 |
| 仓库 `broadcast/<脚本>/56/run-latest.json` | 部署后提交到仓库 |
| npm `@gangfun/cli` 新版本里的 mainnet 地址 | CLI 发布（对公众开放创建）时 |

每个候选地址还要过链上指纹：V3 / 打新各自的常量（税率范围、10,000 份、上限 0.1%–0.5% 等）、真实 Agent ID 注册表和 WBNB、迁移合约和手续费合约都指回它自己、手续费合约的回购地址是 gang 的 GangBuybackBurner、带审计版才有的路由入口。

只查一下：`gang-sniper discover`（`--follow` 一直等）。手动指定：`SNIPER_PAD`（V3）、`SNIPER_FAIR_PAD`（打新）。

## 打新

规则：一半供应量分 10,000 份统一价认购，每个钱包最多 0.1%–0.5%，限时 1–72 小时，打满即在 PancakeSwap 开盘（开盘价 = 打新价），没打满全额退款。开盘后每笔交易 1% 税，其中一半给打新进来、持仓没跌破持仓线的地址。

| 设置（`fair`） | 默认 | 说明 |
|---|---|---|
| `maxSales` | 1 | 总共自动打几场（跨重启计数） |
| `shares` | `cap` | 打满单钱包上限；也可以填份数 |
| `maxSpend.wbnb` | 0.6 | 每场本金 + 打新手续费上限（合约允许的最贵一场是 0.525） |
| `maxMintFeeBps` | 500 | 打新手续费高于这个就不打 |
| `sellPctOnLaunch` | 50 | 开盘后立刻在 PancakeSwap 卖出的比例 |
| `keepReward` | true | 不卖穿持仓线（跌破就永久失去持有奖励）；持仓线 50% 时卖一半正好不穿 |
| `sellSlippagePct` | 5 | |
| `autoRefund` | true | 到期没打满自动领回本金 + 手续费 |

流程：新一场出现 → 打满上限（快满时剩多少打多少，打满的那笔会直接开盘）→ 立刻授权代币给 PancakeSwap（锁仓期间也能授权）→ 开盘后卖出设定比例 → 剩下的拿着。

V3 狙击和打新共用钱包里的 WBNB：打新的钱要等开盘或退款才回来，期间 V3 可能因余额不足跳过。

## 风控

| 项 | 默认 |
|---|---|
| 单笔最多花费 | 0.06 WBNB |
| 每日预算 | 0.5 WBNB |
| 买税 / 卖税上限 | 3% / 3% |
| 滑点 | 3% |
| 同一创建者每天最多买 | 2 次 |
| 创建者黑名单 / 白名单 | 空 |
| 同一个币 | 只买一次（多个 WSS 同时收到、断线补查都会去重） |
| 断线补查到的旧币 | 落后超过 3 个块不追 |
| 风控要求 App 确认的单 | 跳过 |
| 模式 | dry-run |

## 命令

| 命令 | 作用 |
|---|---|
| `gang-sniper doctor` | 自检：钱包、Agent ID、App 开关、余额、授权、WSS、V3 地址 |
| `gang-sniper config` | 交互设置 |
| `gang-sniper presets` | 列出买入档位和卖出规则 |
| `gang-sniper prepare [--wrap 0.3]` | BNB 换 WBNB；V3 地址已知时授权（额度 = 每日预算） |
| `gang-sniper run` | 开始狙击（没有 V3 地址时先自动发现） |
| `gang-sniper status` | 持仓与实时估值、下一步动作 |
| `gang-sniper sell <币地址> [--pct 100]` | 手动卖出 |
| `gang-sniper discover [--follow]` | 只查找 V3 地址并保存 |
| `gang-sniper replay [--from 块号]` | 把历史 `Created` 过一遍下单逻辑（配合 `SNIPER_NETWORK=testnet`） |
| `gang-sniper -v` | 版本 |

## 配置

`gang-sniper config` 会写 `~/.gang-sniper/config.json`，也可以直接编辑：

```json
{
  "size": "0.5",
  "exit": "ladder",
  "exitOverrides": { "stopLossPct": 40, "maxHoldMin": 480 },
  "quotes": ["wbnb"],
  "maxBuyTaxBps": 300,
  "maxSellTaxBps": 300,
  "slippagePct": 3,
  "maxSpendQuote": { "wbnb": "0.06", "usdt": "50" },
  "dailyBudgetQuote": { "wbnb": "0.5", "usdt": "400" },
  "skipCreators": [],
  "onlyCreators": [],
  "maxPerCreatorPerDay": 2,
  "dryRun": true
}
```

环境变量（优先级高于配置文件）：

| 变量 | 作用 |
|---|---|
| `SNIPER_DATA_DIR` | 数据目录，默认 `~/.gang-sniper` |
| `SNIPER_PAD` / `SNIPER_FAIR_PAD` | 手动指定 V3 / 打新合约地址 |
| `SNIPER_WSS` | WSS 节点，可逗号分隔多个，同时订阅、谁先到用谁。默认 `wss://bsc-rpc.publicnode.com` |
| `SNIPER_RPC` | HTTP RPC。默认 `https://bsc-rpc.publicnode.com` |
| `SNIPER_SIZE` / `SNIPER_EXIT` | 临时覆盖档位和卖出规则 |
| `SNIPER_BAW` | 用哪个 baw（钱包），例如 `~/.baw2-cli/bin/baw`；默认 `baw` |
| `SNIPER_SECRETS` | 私有 RPC 配置文件，默认 `~/.config/gang-sniper/secrets.json` |
| `SNIPER_DRY_RUN` | `0` = 实盘，`1` = dry-run |
| `SNIPER_AUTO_DISCOVER` | `0` = 关闭自动发现 |
| `SNIPER_NETWORK` | `testnet` = BSC 测试网（只能监听和回放，baw 不支持测试网下单） |

## 日志与数据

都在 `~/.gang-sniper/`：

| 文件 | 内容 |
|---|---|
| `config.json` | 配置，以及自动发现到的 V3 地址 |
| `state.json` | 持仓、已买过的币、当日花费、发现进度 |
| `sniper.log` | 每行一个 JSON 事件 |

常见事件：`created`（收到新币）、`skip`（没买，带原因）、`dry_run_buy`、`buy_sent`、`buy_filled`、
`sold`、`v3_waiting` / `v3_candidate` / `v3_discovered`（自动发现）、`wss_reconnect`。

```bash
tail -f ~/.gang-sniper/sniper.log | grep -E '"(buy_filled|sold|skip)"'
```

## 常见问题

**`baw 未登录`**：运行 `baw auth signin` 扫码登录。

**`找不到 baw`**：`npm i -g @binance/agentic-wallet`。

**一直超时 / `HTTP request failed`**：网络连不上 BSC 节点或币安。国内设好 `HTTPS_PROXY`，或把 `SNIPER_RPC` / `SNIPER_WSS` 换成能连上的节点。

**`钱包没有 Agent ID`**：在币安 App 的 Agentic Wallet 里领取 `.ai` Agent ID，V3 内盘只对 Agent 开放。

**日志里有 `skip` `confirmation`**：币安风控要求在 App 里确认这笔交易，狙击器不会等人工确认。把 App 的「异常交易处理」改成不需要确认。

**`skip` `tax`**：这个币的真实税率超过了你设的上限。

**`skip` `insufficient_quote`**：WBNB 不够，`gang-sniper prepare --wrap <数量>`。

**一直 `v3_waiting`**：主网 V3 还没上线，正常现象。如果确认已经上线但一直没发现，可能团队换了手续费合约，手动设 `SNIPER_PAD`。

## 开发

```bash
git clone https://github.com/gunksd/gang-v3-sniper && cd gang-v3-sniper
npm install
npm test                 # 单元测试
npm run test:testnet     # BSC 测试网集成测试（需要网络）
node bin/gang-sniper.js doctor
```

| 文件 | 作用 |
|---|---|
| `bin/gang-sniper.js` | 启动器：检查 Node 版本、自动开代理、转发停止信号 |
| `src/cli.js` | 命令 |
| `src/listener.js` | WSS 订阅 `Created`，多节点、心跳、断线补查、去重 |
| `src/curve.js` | 内盘曲线数学（移植自 LaunchpadV3.sol） |
| `src/strategy.js` | 下单规划、税率检查、卖出规则（纯函数） |
| `src/sniper.js` | 运行时：下单、记仓位、卖出 |
| `src/discover.js` | V3 地址自动发现 |
| `src/baw.js` | `baw` 封装 |
| `src/config.js` | 配置与预设 |

合约参考：[gangfun/gang-launchpad `feat/v3-tax-recipient`](https://github.com/gangfun/gang-launchpad/tree/feat/v3-tax-recipient/src/launchpad-v3)，
测试网部署记录 [TESTNET-LAUNCHPAD-V3-2026-10-26.md](https://github.com/gangfun/gang-launchpad/blob/feat/v3-tax-recipient/docs/TESTNET-LAUNCHPAD-V3-2026-10-26.md)。
