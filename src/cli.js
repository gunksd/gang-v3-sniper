/** gang-sniper CLI entry (loaded by bin/gang-sniper.js after the proxy / Node version check). */
import { createInterface } from 'node:readline/promises'
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { formatUnits, parseUnits, maxUint256 } from 'viem'
import { loadConfig as loadConfigRaw, SIZE_PRESETS, EXIT_PRESETS, DEFAULTS, CONFIG_FILE, DATA_DIR, SECRETS_FILE, exitRule, quoteAddresses, quoteKey, redact } from './config.js'
import { checkAnchor, fingerprintV3, discoverPad } from './discover.js'
import { makeClient, isAgent, balanceOf, allowance, calldata, createdLogs, readCurve } from './chain.js'
import { bawAddress, bawStatus, bawSettings, bawSend, useBawBin, bawBin, bawInteractive, requireBaw } from './baw.js'
import { Sniper } from './sniper.js'
import { planBuy, checkTax, evaluateExit, multipleOf } from './strategy.js'
import { loadState, openPositions } from './state.js'
import { CREATED_TOPIC } from './abi.js'
import { log, setQuiet } from './log.js'

/** Load config and point every baw call at the selected wallet's session. */
const loadConfig = (o) => {
  const cfg = loadConfigRaw(o)
  useBawBin(cfg.bawBin)
  return cfg
}

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const args = process.argv.slice(2)
const cmd = args[0]
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def }
const fmt = (x) => formatUnits(BigInt(x), 18)
const print = (o) => console.log(JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2))

function describeExit(name, r) {
  const tail = [r.stopLossPct ? `止损 -${r.stopLossPct}%` : null, r.maxHoldMin ? `最长持有 ${r.maxHoldMin} 分钟` : null].filter(Boolean).join('，')
  const head = {
    multiple: `涨到 ${r.takeProfitX} 倍全部卖出`,
    ladder: `分批止盈：${(r.steps || []).map((s) => `${s.x}x 卖 ${s.pct}%`).join(' / ')}`,
    progress: `内盘进度到 ${r.progressPct}% 全部卖出`,
    graduate: '持有到毕业，毕业后在 Pancake 外盘卖出（只付卖税）',
    manual: '不自动卖，用 `gang-sniper sell` 手动卖',
  }[r.kind]
  return `${name}: ${head}${tail ? `；${tail}` : ''}`
}

async function ask(rl, q, choices, def) {
  const list = choices.map((c, i) => `  ${i + 1}) ${c.label}${c.value === def ? '  (当前)' : ''}`).join('\n')
  const a = (await rl.question(`${q}\n${list}\n> `)).trim()
  if (!a) return def
  const n = Number(a)
  if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1].value
  return choices.find((c) => c.value === a)?.value ?? def
}

async function askNum(rl, q, def) {
  const a = (await rl.question(`${q} [${def}]: `)).trim()
  if (!a) return def
  const n = Number(a)
  return Number.isFinite(n) ? n : def
}

async function configCmd() {
  mkdirSync(DATA_DIR, { recursive: true })
  const cur = { ...DEFAULTS, ...(existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) : {}) }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const size = await ask(rl, '每个新币买多少（占总量）？单地址上限 1%', Object.keys(SIZE_PRESETS).map((k) => ({ value: k, label: `${k}%` })), cur.size)
    const exit = await ask(rl, '卖出规则？', Object.entries(EXIT_PRESETS).map(([k, r]) => ({ value: k, label: describeExit(k, r) })), cur.exit)
    const base = EXIT_PRESETS[exit]
    const ov = {}
    if (base.kind === 'multiple') ov.takeProfitX = await askNum(rl, '止盈倍数', cur.exitOverrides?.takeProfitX ?? base.takeProfitX)
    if (base.kind === 'progress') ov.progressPct = await askNum(rl, '卖出时的内盘进度 %', cur.exitOverrides?.progressPct ?? base.progressPct)
    if (base.kind !== 'manual') {
      ov.stopLossPct = await askNum(rl, '止损 %（0 = 关闭）', cur.exitOverrides?.stopLossPct ?? base.stopLossPct)
      ov.maxHoldMin = await askNum(rl, '最长持有分钟（0 = 不限）', cur.exitOverrides?.maxHoldMin ?? base.maxHoldMin)
    }
    const quotes = await ask(rl, '狙哪些计价币的新币？', [
      { value: 'wbnb', label: '只狙 BNB 计价' }, { value: 'usdt', label: '只狙 USDT 计价' }, { value: 'wbnb,usdt', label: 'BNB 和 USDT 都狙' },
    ], cur.quotes.join(','))
    const maxBuyTaxBps = Math.round((await askNum(rl, '买税上限 %', cur.maxBuyTaxBps / 100)) * 100)
    const maxSellTaxBps = Math.round((await askNum(rl, '卖税上限 %', cur.maxSellTaxBps / 100)) * 100)
    const slippagePct = await askNum(rl, '滑点 %', cur.slippagePct)
    const maxWbnb = String(await askNum(rl, '单笔最多花多少 WBNB', Number(cur.maxSpendQuote.wbnb)))
    const dayWbnb = String(await askNum(rl, '每天最多花多少 WBNB', Number(cur.dailyBudgetQuote.wbnb)))
    const dryRun = (await ask(rl, '运行模式？', [{ value: 'dry', label: 'dry-run：只记录不下单' }, { value: 'live', label: '实盘' }], cur.dryRun ? 'dry' : 'live')) === 'dry'
    const next = {
      ...cur, size, exit, exitOverrides: ov, quotes: quotes.split(','), maxBuyTaxBps, maxSellTaxBps, slippagePct,
      maxSpendQuote: { ...cur.maxSpendQuote, wbnb: maxWbnb }, dailyBudgetQuote: { ...cur.dailyBudgetQuote, wbnb: dayWbnb }, dryRun,
    }
    writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n')
    console.log(`\n已保存 ${CONFIG_FILE}\n买入 ${size}%｜${describeExit(exit, { ...base, ...ov })}｜${dryRun ? 'dry-run' : '实盘'}`)
  } finally {
    rl.close()
  }
}

function presetsCmd() {
  console.log('买入档位（占总量，单地址上限 1%）：', Object.keys(SIZE_PRESETS).map((k) => `${k}%`).join('  '))
  console.log('\n卖出规则：')
  for (const [k, r] of Object.entries(EXIT_PRESETS)) console.log(`  ${describeExit(k, r)}`)
  console.log('\n设置：gang-sniper config，或环境变量 SNIPER_SIZE=0.5 SNIPER_EXIT=ladder')
}

async function doctorCmd() {
  const cfg = loadConfig()
  const client = makeClient(cfg.net)
  const out = {
    network: cfg.network, baw: bawBin(), pad: cfg.net.pad, rpc: redact(cfg.net.rpc), wss: cfg.net.wss.split(',').map(redact),
    secrets: existsSync(SECRETS_FILE) ? SECRETS_FILE : 'none (public nodes)',
    dryRun: cfg.dryRun, size: `${cfg.size}%`, exit: exitRule(cfg), issues: [],
  }
  if (cfg.net.v3Anchor) {
    const anchorErr = await checkAnchor(client, cfg.net)
    out.anchor = { bucket: cfg.net.v3Anchor.bucket, owner: cfg.net.v3Anchor.owner, ok: !anchorErr }
    if (anchorErr) out.issues.push(`自动发现的信任锚异常：${anchorErr}`)
  }
  if (!cfg.net.pad) {
    out.pad = cfg.autoDiscover ? 'not found yet: `run` waits for it (auto-discovery)' : null
    if (!cfg.autoDiscover) out.issues.push('没有 V3 地址且 autoDiscover 关闭')
  } else if (cfg.net.v3Anchor) {
    const fp = await fingerprintV3(client, cfg.net.pad, cfg.net)
    out.padFingerprint = { ok: fp.ok, reasons: fp.reasons, owner: fp.facts.owner, tokenCount: fp.facts.tokenCount }
    if (!fp.ok) out.issues.push(`pad 指纹不符：${fp.reasons.join('；')}`)
  }
  out.bawStatus = await bawStatus()
  if (out.bawStatus !== 'CONNECTED') {
    out.issues.push(`钱包未登录：${bawBin()} auth signin`)
    return print(out)
  }
  out.wallet = await bawAddress()
  const s = await bawSettings()
  out.settings = { devMode: s.devMode?.enabled, devModeExpires: s.devMode?.expiresAt, tradeAllTokens: s.tradeAllTokens, abnormalTxnHandling: s.abnormalTxnHandling, quotaLeft: s.quotaLeft }
  if (!s.devMode?.enabled) out.issues.push('App 里打开 Developer Mode')
  if (!s.tradeAllTokens) out.issues.push('App 里打开 Trade all tokens')
  if (s.abnormalTxnHandling === 'NeedConfirmation') out.issues.push('abnormalTxnHandling=NeedConfirmation：风控判为异常的交易会等 App 确认，这类单会被跳过')
  out.bnb = fmt(await client.getBalance({ address: out.wallet }))
  out.quotes = {}
  if (cfg.net.pad) {
    out.isAgent = await isAgent(client, cfg.net.pad, out.wallet).catch((e) => `read failed: ${e.shortMessage || e.message}`)
    if (out.isAgent !== true) out.issues.push('钱包没有 Agent ID（.ai），V3 内盘买不了')
    for (const q of quoteAddresses(cfg)) {
      const [b, a] = await Promise.all([balanceOf(client, q, out.wallet), allowance(client, q, out.wallet, cfg.net.pad)])
      const need = parseUnits(String(cfg.maxSpendQuote[quoteKey(cfg, q)] ?? '0'), 18)
      out.quotes[q] = { balance: fmt(b), approved: fmt(a) }
      if (a < need) out.issues.push(`${q} 授权不足一单：gang-sniper prepare（实盘 + autoPrepare 时自动补）`)
      if (b < need) out.issues.push(`${q} 余额 ${fmt(b)} 不够一单 ${fmt(need)}`)
    }
  } else {
    for (const q of quoteAddresses(cfg)) out.quotes[q] = { balance: fmt(await balanceOf(client, q, out.wallet)) }
    if (cfg.net.agentIdRegistry) {
      const n = await client.readContract({ address: cfg.net.agentIdRegistry, abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }], functionName: 'balanceOf', args: [out.wallet] }).catch(() => null)
      out.isAgent = n == null ? 'read failed' : n > 0n
      if (out.isAgent === false) out.issues.push('钱包没有 Agent ID（.ai），V3 内盘买不了')
    }
  }
  out.wssProbe = []
  for (const u of cfg.net.wss.split(',').map((x) => x.trim()).filter(Boolean)) {
    const r = await probeWss(u, cfg.net.pad || cfg.net.v3Anchor?.bucket)
    out.wssProbe.push({ ...r, url: redact(u), ...(r.error && { error: redact(r.error) }) })
  }
  if (!out.wssProbe.some((r) => r.ok)) out.issues.push('所有 WSS 订阅都失败')
  print(out)
}

function probeWss(url, pad) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const ws = new WebSocket(url)
    const done = (r) => { clearTimeout(timer); try { ws.close() } catch { /* */ } resolve({ url, ...r, ms: Date.now() - t0 }) }
    const timer = setTimeout(() => done({ ok: false, error: 'timeout 8s' }), 8000)
    ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['logs', { address: pad, topics: [CREATED_TOPIC] }] }))
    ws.onmessage = (m) => { const r = JSON.parse(String(m.data)); done(r.error ? { ok: false, error: r.error.message } : { ok: true, subId: r.result }) }
    ws.onerror = () => done({ ok: false, error: 'socket error' })
  })
}

async function prepareCmd() {
  const cfg = loadConfig()
  if (!cfg.net.bawChainId) throw new Error(`baw cannot sign on ${cfg.network}`)
  const client = makeClient(cfg.net)
  const me = await requireBaw()
  const wrap = opt('wrap')
  if (wrap) {
    const r = await bawSend({ from: me, to: cfg.net.wbnb, value: parseUnits(wrap, 18), data: calldata.wrap(), chainId: cfg.net.bawChainId })
    print({ step: 'wrap', amount: wrap, ...r })
    if (r.txHash) await client.waitForTransactionReceipt({ hash: r.txHash })
  }
  if (!cfg.net.pad) return print({ step: 'approve', skipped: 'V3 pad not discovered yet; `run` approves it automatically once found (autoPrepare)' })
  for (const q of quoteAddresses(cfg)) {
    // bounded: the daily budget, never unlimited
    const amount = parseUnits(String(cfg.dailyBudgetQuote[quoteKey(cfg, q)]), 18)
    const a = await allowance(client, q, me, cfg.net.pad)
    if (a >= amount) { print({ step: 'approve', quote: q, already: fmt(a) }); continue }
    const r = await bawSend({ from: me, to: q, data: calldata.approve(cfg.net.pad, amount), chainId: cfg.net.bawChainId })
    print({ step: 'approve', quote: q, spender: cfg.net.pad, amount: fmt(amount), ...r })
    if (r.txHash) await client.waitForTransactionReceipt({ hash: r.txHash })
  }
}

async function runCmd() {
  const cfg = loadConfig()
  const client = makeClient(cfg.net)
  const me = await requireBaw()
  log('wallet', { baw: bawBin(), address: me })
  const sniper = new Sniper({ cfg, client, me })
  // before start(): start() can wait a long time in V3 auto-discovery
  const stop = (sig) => { log('stop', { signal: sig }); sniper.stop(); process.exit(0) }
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => stop(sig))
  await sniper.start()
}

async function statusCmd() {
  const cfg = loadConfig()
  const client = makeClient(cfg.net)
  const me = await requireBaw()
  const sniper = new Sniper({ cfg, client, me })
  const st = loadState()
  const rows = []
  for (const p of Object.values(st.positions)) {
    const row = { token: p.token, symbol: p.symbol, status: p.status, exit: p.exit, tokens: fmt(p.tokens), remaining: fmt(p.remaining), cost: fmt(p.cost), proceeds: fmt(p.proceeds) }
    if (p.status === 'open') {
      try {
        const m = await sniper.mark(p, BigInt(p.remaining))
        const d = evaluateExit(sniper.rule, p, { value: m.value, progressPct: m.progressPct, graduated: m.graduated, now: Date.now() })
        Object.assign(row, { venue: m.venue, progressPct: m.progressPct, valueNow: fmt(m.value), multiple: multipleOf(p, m.value), next: d.action === 'sell' ? d.reason : 'hold' })
      } catch (e) { row.error = e.shortMessage || e.message }
    }
    rows.push(row)
  }
  print({ daily: st.daily, positions: rows })
}

async function sellCmd() {
  const token = args[1]
  if (!token?.startsWith('0x')) throw new Error('usage: gang-sniper sell <token> [--pct 100]')
  const pct = BigInt(Math.round(Number(opt('pct', '100'))))
  const cfg = loadConfig()
  const client = makeClient(cfg.net)
  const me = await requireBaw()
  const sniper = new Sniper({ cfg, client, me })
  const pos = sniper.state.positions[token.toLowerCase()]
  if (!pos) throw new Error(`no position for ${token}`)
  const amount = (BigInt(pos.remaining) * pct) / 100n
  await sniper.sell(pos, amount, `manual ${pct}%`)
}

/** Feed historical Created logs (e.g. the testnet V3 run) through the planner + tax check, no orders. */
async function replayCmd() {
  const cfg = loadConfig({ dryRun: true })
  if (!cfg.net.pad) throw new Error('replay needs a pad (SNIPER_PAD) — none known yet')
  const client = makeClient(cfg.net)
  const head = await client.getBlockNumber()
  const from = BigInt(opt('from', String(head - 50_000n)))
  const state = loadState()
  const out = []
  for (let b = from; b <= head; b += 5000n) {
    const to = b + 4999n > head ? head : b + 4999n
    for (const ev of await createdLogs(client, cfg.net.pad, b, to)) {
      const plan = planBuy(cfg, ev, state)
      const curve = await readCurve(client, cfg.net.pad, ev.token)
      out.push({
        block: ev.blockNumber, token: ev.token, symbol: ev.symbol, quote: ev.quote, creator: ev.creator,
        buyTaxBps: curve.buyTaxBps, sellTaxBps: curve.sellTaxBps,
        decision: plan.skip ? `skip: ${plan.skip}` : (checkTax(cfg, curve) ? `skip: ${checkTax(cfg, curve)}` : 'buy'),
        ...(plan.skip ? {} : { quoteIn: fmt(plan.quoteIn), minTokensOut: fmt(plan.minTokensOut) }),
      })
    }
  }
  print({ network: cfg.network, pad: cfg.net.pad, fromBlock: from, toBlock: head, events: out })
}

/** One-shot: look for the V3 pad from the anchor bucket's history, print it, save it. */
async function discoverCmd() {
  const cfg = loadConfig({ pad: null })
  const net = { ...cfg.net, pad: null }
  if (!net.v3Anchor) throw new Error(`no discovery anchor for ${cfg.network}`)
  const client = makeClient(net)
  // default: the recent window the public RPC still serves; --from only helps with an archive SNIPER_RPC
  const fromBlock = opt('from') ? BigInt(opt('from')) : null
  const follow = args.includes('--follow')
  const ctl = new AbortController()
  if (!follow) setTimeout(() => ctl.abort(), Number(opt('timeout', '60')) * 1000)
  try {
    const found = await discoverPad({ client, net, fromBlock, signal: ctl.signal })
    const { savePad } = await import('./config.js')
    if (!args.includes('--no-save')) savePad(cfg.network, found.pad, { operatorTx: found.event.txHash, operatorBlock: found.event.blockNumber, owner: found.facts.owner })
    print({ found: true, pad: found.pad, operatorTx: found.event.txHash, block: found.event.blockNumber, facts: found.facts, saved: !args.includes('--no-save') })
  } catch (e) {
    if (e.message !== 'discovery aborted') throw e
    print({ found: false, scannedFrom: fromBlock ?? 'last ~9000 blocks', note: 'no bucket operator passes the V3 fingerprint yet; `run` keeps watching (or `discover --follow`)' })
  }
  process.exit(0)
}

const HELP = `gang-sniper ${VERSION} — gang.fun LaunchpadV3 狙击器（币安 Agentic Wallet）

  gang-sniper doctor               检查钱包、Agent ID、余额、授权、WSS、V3 地址
  gang-sniper config               交互设置：买入档位 / 卖出规则 / 计价币 / 税上限 / 滑点 / 限额 / 实盘或 dry-run
  gang-sniper presets              列出买入档位和卖出规则
  gang-sniper prepare [--wrap 0.3] BNB 换 WBNB；V3 地址已知时授权（额度 = 每日预算）
  gang-sniper run                  开始狙击（没有 V3 地址时先自动发现）
  gang-sniper status               持仓和实时估值
  gang-sniper sell <币地址> [--pct 100]   手动卖出
  gang-sniper discover [--follow]  只查找 V3 地址并保存
  gang-sniper wallet <baw 参数>    用配置的 baw（bawBin / SNIPER_BAW）执行，例如 wallet wallet balance --binanceChainId 56
  gang-sniper replay [--from 块号]  测试网：把历史 Created 事件过一遍下单逻辑（SNIPER_NETWORK=testnet）

数据目录：${DATA_DIR}（可用 SNIPER_DATA_DIR 改）
默认 dry-run，只记录不下单；实盘请先跑 config。`

/** `gang-sniper wallet <baw args>`: run the configured baw (bawBin / SNIPER_BAW) with these args. */
async function walletCmd() {
  loadConfig()
  const rest = args.slice(1)
  if (!rest.length) return print({ baw: bawBin(), usage: 'gang-sniper wallet wallet status | wallet address | wallet balance --binanceChainId 56' })
  process.exit(await bawInteractive(rest))
}

const COMMANDS = { wallet: walletCmd, discover: discoverCmd, config: configCmd, presets: presetsCmd, doctor: doctorCmd, prepare: prepareCmd, run: runCmd, status: statusCmd, sell: sellCmd, replay: replayCmd }

if (cmd === '--version' || cmd === '-v') { console.log(VERSION); process.exit(0) }
const fn = COMMANDS[cmd]
if (!fn) {
  console.log(HELP)
  process.exit(cmd ? 1 : 0)
}
if (['status', 'replay', 'discover'].includes(cmd)) setQuiet(true)
Promise.resolve(fn()).catch((e) => { console.error(JSON.stringify({ error: e.message })); process.exit(1) })
