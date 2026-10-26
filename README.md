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

## V3 地址自动发现

不填地址直接 `run`，程序先等主网 V3 出现，找到后保存到 `~/.gang-sniper/config.json`，然后开始狙击。

判定分两层：

1. **信任锚**：主网部署脚本复用现网的平台手续费合约
   [`0xBDDd…F111`](https://bscscan.com/address/0xBDDd8F275D7Cb65f5454D0bEDf0463792878F111)，
   owner 是 gang 团队地址 `0x4EEd…19d3`。新发射台必须被 owner 设为 operator 才能交易（否则买入会回滚），
   这会发出 `OperatorUpdated` 事件，**只有 owner 能发**。程序用 WSS 订阅 + HTTP 轮询盯这个事件。
2. **合约指纹**：候选地址还必须满足 V3 独有特征才算数：
   平台抽成 0.5%、税率范围 1%–5%、手续费合约指回同一个、税收路由和迁移合约都指回它自己、
   Agent 门槛和 1% 上限开启、确实是 operator。

别人部署的山寨合约拿不到 operator 身份，过不了第 1 层。V2 发射台和税收路由合约同样是 operator，但过不了第 2 层。

找到之后：

- 从 operator 交易所在的块开始补查 `Created`（落后超过 3 个块的币不追）
- 实盘模式下自动授权 WBNB，**额度 = 每日预算**，不做无限授权，额度不够时自动补
- 每次启动都会重新验一遍指纹

只想查一下，不开始狙击：

```bash
gang-sniper discover            # 扫一次
gang-sniper discover --follow   # 一直等到出现
```

也可以手动指定：`SNIPER_PAD=0x…`，或写进 `~/.gang-sniper/config.json` 的 `pad`。

> 免费公共节点只保留最近约 9000 个块（约 8 小时）的日志。程序停机超过这个时间，期间的上线事件只能靠下一次实时订阅收到；
> 程序会记录扫描进度，停机不超过 8 小时重启不会漏。需要更长的回溯可以把 `SNIPER_RPC` 设成归档节点。

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
| `SNIPER_PAD` | 手动指定 V3 地址 |
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
