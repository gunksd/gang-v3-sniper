/**
 * Runtime: Created event → plan → (curves() tax check ∥ baw preview) → execute → record position → exit loop.
 * The hot path before the preview is pure computation on event data (quote comes from topics[3]); the only RPC,
 * curves() for the real tax, runs in parallel with the preview and gates the execute.
 */
import { decodeEventLog, formatUnits, parseUnits, maxUint256 } from 'viem'
import { V3_ABI } from './abi.js'
import { readCurve, balanceOf, allowance, calldata, poolAmountOut } from './chain.js'
import { simulateSell, progressPct } from './curve.js'
import { planBuy, checkTax, evaluateExit, minOut } from './strategy.js'
import { exitRule, quoteAddresses, quoteKey, savePad } from './config.js'
import { discoverPad, fingerprintV3 } from './discover.js'
import { bawSend, bawPreview, bawExecute } from './baw.js'
import { loadState, saveState, markSniped, addSpend, putPosition, openPositions, rollDay } from './state.js'
import { listenCreated } from './listener.js'
import { log } from './log.js'

const fmt = (x) => formatUnits(BigInt(x), 18)
// a Created older than this when it reaches us (backfill after a WSS gap) is not sniped: the open price is gone
const STALE_BLOCKS = 3n

export class Sniper {
  constructor({ cfg, client, me }) {
    this.cfg = cfg
    this.client = client
    this.me = me
    this.pad = cfg.net.pad
    this.rule = exitRule(cfg)
    this.state = loadState()
    this.funds = new Map() // quote → { balance, allowance }
    this.busy = new Set() // tokens with an exit in flight
    this.canExecute = !cfg.dryRun && !!cfg.net.bawChainId
    this.approving = new Set() // quotes with an approve in flight
  }

  persist(next) {
    this.state = next
    saveState(next)
  }

  async refreshFunds() {
    if (!this.pad) return
    for (const q of quoteAddresses(this.cfg)) {
      try {
        const [b, a] = await Promise.all([balanceOf(this.client, q, this.me), allowance(this.client, q, this.me, this.pad)])
        this.funds.set(q, { balance: b, allowance: a })
        // keep the bounded approval topped up so a snipe never waits on an approve tx
        if (this.canExecute && this.cfg.autoPrepare && a < this.spendCap(q)) this.approveQuote(q).catch((e) => log('approve_error', { quote: q, error: e.message }))
      } catch (e) {
        log('funds_error', { quote: q, error: e.shortMessage || e.message })
      }
    }
  }

  /** Largest single snipe for a quote; the approval must cover at least this. */
  spendCap(q) {
    const v = this.cfg.maxSpendQuote[quoteKey(this.cfg, q)]
    return v == null ? 0n : parseUnits(String(v), 18)
  }

  /** Approve the pad for the daily budget of `q` (bounded on purpose: never an unlimited quote approval). */
  async approveQuote(q) {
    if (this.approving.has(q)) return
    const budget = this.cfg.dailyBudgetQuote[quoteKey(this.cfg, q)]
    if (budget == null) return
    this.approving.add(q)
    try {
      const amount = parseUnits(String(budget), 18)
      const r = await bawSend({ from: this.me, to: q, data: calldata.approve(this.pad, amount), chainId: this.cfg.net.bawChainId })
      if (!r.ok || !r.txHash) throw new Error(`approve ${q}: ${JSON.stringify(r.error || r.status)}`)
      await this.client.waitForTransactionReceipt({ hash: r.txHash, timeout: 90_000 })
      log('quote_approved', { quote: q, spender: this.pad, amount: fmt(amount), txHash: r.txHash })
      const a = await allowance(this.client, q, this.me, this.pad)
      this.funds.set(q, { ...(this.funds.get(q) || { balance: 0n }), allowance: a })
    } finally {
      this.approving.delete(q)
    }
  }

  // ------------------------------------------------------------------ entry
  async onCreated(ev, meta) {
    const t0 = Date.now()
    this.state = rollDay(this.state)
    const base = { token: ev.token, symbol: ev.symbol, quote: ev.quote, creator: ev.creator, block: ev.blockNumber, tx: ev.txHash, source: meta.source }
    log('created', { ...base, name: ev.name, gradAmt: fmt(ev.gradAmt) })

    if (meta.backfilled && meta.head != null && meta.head - ev.blockNumber > STALE_BLOCKS) {
      return log('skip', { ...base, reason: 'stale_backfill', behindBlocks: meta.head - ev.blockNumber })
    }
    const plan = planBuy(this.cfg, ev, this.state)
    if (plan.skip) return log('skip', { ...base, reason: plan.skip, ...plan })

    const funds = this.funds.get(plan.quote)
    const fundsIssue = !funds ? null
      : funds.balance < plan.quoteIn ? { reason: 'insufficient_quote', need: fmt(plan.quoteIn), have: fmt(funds.balance) }
        : funds.allowance < plan.quoteIn ? { reason: 'quote_not_approved', hint: 'run `gang-sniper prepare`' } : null
    if (fundsIssue && this.canExecute) return log('skip', { ...base, ...fundsIssue })

    // reserve before any await: a second WSS / backfill copy of this event must not buy again
    this.persist(markSniped(this.state, ev.token, { plan: { quoteIn: plan.quoteIn, sizeBps: plan.sizeBps }, dryRun: !this.canExecute }))
    const call = { from: this.me, to: this.pad, data: calldata.buy(ev.token, plan.quoteIn, plan.minTokensOut), chainId: this.cfg.net.bawChainId }
    const planLog = { ...base, sizeBps: plan.sizeBps, quoteIn: fmt(plan.quoteIn), minTokensOut: fmt(plan.minTokensOut), decideMs: Date.now() - t0 }

    if (!this.canExecute) {
      const curve = await readCurve(this.client, this.pad, ev.token).catch(() => null)
      return log('dry_run_buy', { ...planLog, ...(fundsIssue && { fundsIssue }), taxCheck: curve ? (checkTax(this.cfg, curve) || 'ok') : 'curve read failed', buyTaxBps: curve?.buyTaxBps, sellTaxBps: curve?.sellTaxBps })
    }

    const taxGate = readCurve(this.client, this.pad, ev.token).then((c) => ({ curve: c, error: checkTax(this.cfg, c) }), (e) => ({ error: `curves() failed: ${e.shortMessage || e.message}` }))
    // preview and execute are split so the tax result can veto between them
    const [p, tax] = await Promise.all([bawPreview(call), taxGate])
    const previewMs = Date.now() - t0
    if (tax.error) return log('skip', { ...planLog, reason: 'tax', detail: tax.error, previewMs })
    if (!p.ok) return log('buy_failed', { ...planLog, stage: 'preview', error: p.error, previewMs })
    if (!p.simulationOk) return log('buy_failed', { ...planLog, stage: 'simulation', error: p.simulationError, previewMs })
    if (p.requireConfirmation) return log('buy_failed', { ...planLog, stage: 'confirmation', error: 'risk engine requires App confirmation', previewMs })
    const e = await bawExecute(p.requestId)
    const sentMs = Date.now() - t0
    if (!e.ok || !e.txHash) return log('buy_failed', { ...planLog, stage: 'execute', error: e.error || e.status, previewMs, sentMs })
    log('buy_sent', { ...planLog, txHash: e.txHash, previewMs, sentMs })
    this.persist(addSpend(this.state, plan.key, plan.quoteIn, ev.creator))
    this.confirmBuy(ev, plan, e.txHash, tax.curve).catch((err) => log('buy_confirm_error', { ...base, txHash: e.txHash, error: err.message }))
  }

  async confirmBuy(ev, plan, hash, curve) {
    const r = await this.client.waitForTransactionReceipt({ hash, timeout: 90_000 })
    if (r.status !== 'success') {
      log('buy_reverted', { token: ev.token, txHash: hash, block: r.blockNumber })
      // refund the daily counter: nothing was spent
      this.persist(addSpend(this.state, plan.key, -plan.quoteIn, ev.creator))
      return this.refreshFunds()
    }
    let fill = null
    for (const l of r.logs) {
      if (l.address.toLowerCase() !== this.pad.toLowerCase()) continue
      try {
        const d = decodeEventLog({ abi: V3_ABI, ...l })
        if (d.eventName === 'Buy' && d.args.buyer.toLowerCase() === this.me.toLowerCase()) fill = d.args
      } catch { /* other event */ }
    }
    if (!fill) return log('buy_confirm_error', { token: ev.token, txHash: hash, error: 'no Buy event for this wallet in receipt' })
    const cost = fill.quoteIn + fill.protocolFee + fill.tax // gross kept by the pad; the refund came back
    const pos = {
      token: ev.token, symbol: ev.symbol, quote: ev.quote, pad: this.pad, creator: ev.creator,
      tokens: fill.tokensOut.toString(), remaining: fill.tokensOut.toString(), cost: cost.toString(), proceeds: '0',
      buyTaxBps: Number(curve?.buyTaxBps ?? 0), sellTaxBps: Number(curve?.sellTaxBps ?? 0),
      exit: this.rule.name, stepsDone: 0, openedAt: Date.now(), buyTx: hash, buyBlock: r.blockNumber.toString(),
      blocksAfterCreate: (r.blockNumber - ev.blockNumber).toString(), status: 'open', sells: [],
    }
    this.persist(putPosition(this.state, pos))
    log('buy_filled', { token: ev.token, symbol: ev.symbol, tokens: fmt(fill.tokensOut), cost: fmt(cost), blocksAfterCreate: pos.blocksAfterCreate, txHash: hash })
    this.refreshFunds()
    // approve the pad to pull our tokens on a curve sell, now, so an exit is one tx
    this.ensureApproval(ev.token, this.pad).catch((err) => log('approve_error', { token: ev.token, error: err.message }))
  }

  async ensureApproval(token, spender) {
    const a = await allowance(this.client, token, this.me, spender)
    if (a > maxUint256 / 2n) return true
    const r = await bawSend({ from: this.me, to: token, data: calldata.approve(spender), chainId: this.cfg.net.bawChainId })
    if (!r.ok || !r.txHash) throw new Error(`approve ${token} → ${spender}: ${JSON.stringify(r.error || r.status)}`)
    await this.client.waitForTransactionReceipt({ hash: r.txHash, timeout: 90_000 })
    log('approved', { token, spender, txHash: r.txHash })
    return true
  }

  // ------------------------------------------------------------------ exit
  /** Value of `amount` tokens if sold now, after exit fees; plus curve progress / graduation. */
  async mark(pos, amount) {
    const curve = await readCurve(this.client, pos.pad, pos.token)
    if (!curve.graduated) {
      return { venue: 'curve', curve, graduated: false, progressPct: progressPct(curve), value: amount > 0n ? simulateSell(curve, amount).toUser : 0n }
    }
    // pool sell: the token keeps sellTax of what we send, the pair gets the rest
    const intoPair = amount - (amount * curve.sellTaxBps) / 10_000n
    const value = intoPair > 0n ? await poolAmountOut(this.client, this.cfg.net.router, intoPair, [pos.token, pos.quote]) : 0n
    return { venue: 'pool', curve, graduated: true, pair: curve.pair, progressPct: 100, value }
  }

  async checkExits() {
    for (const pos of openPositions(this.state)) {
      if (this.busy.has(pos.token)) continue
      this.busy.add(pos.token)
      this.checkOne(pos).catch((e) => log('exit_error', { token: pos.token, error: e.shortMessage || e.message })).finally(() => this.busy.delete(pos.token))
    }
  }

  async checkOne(pos) {
    // remaining follows the wallet: a manual sell elsewhere shrinks it
    const held = await balanceOf(this.client, pos.token, this.me)
    if (held < BigInt(pos.remaining)) {
      pos = { ...pos, remaining: held.toString(), ...(held === 0n && { status: 'closed', closedReason: 'balance gone' }) }
      this.persist(putPosition(this.state, pos))
      if (held === 0n) return log('position_closed', { token: pos.token, reason: 'balance gone' })
    }
    const m = await this.mark(pos, BigInt(pos.remaining))
    const d = evaluateExit(this.rule, pos, { value: m.value, progressPct: m.progressPct, graduated: m.graduated, now: Date.now() })
    if (d.action !== 'sell') return
    return this.sell(pos, d.amount, d.reason, d.step)
  }

  /** Sell `amount` of a position on the curve or, after graduation, on Pancake. */
  async sell(pos, amount, reason, step) {
    const m = await this.mark(pos, amount)
    const expected = m.value
    const min = minOut(expected, this.cfg.slippagePct)
    const info = { token: pos.token, symbol: pos.symbol, venue: m.venue, amount: fmt(amount), expected: fmt(expected), minOut: fmt(min), reason }
    if (!this.canExecute) return log('dry_run_sell', info)

    let call
    if (m.venue === 'curve') {
      await this.ensureApproval(pos.token, pos.pad)
      call = { from: this.me, to: pos.pad, data: calldata.sell(pos.token, amount, min), chainId: this.cfg.net.bawChainId }
    } else {
      await this.ensureApproval(pos.token, this.cfg.net.router)
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 300)
      call = { from: this.me, to: this.cfg.net.router, data: calldata.poolSell(amount, min, [pos.token, pos.quote], this.me, deadline), chainId: this.cfg.net.bawChainId }
    }
    const qBefore = await balanceOf(this.client, pos.quote, this.me)
    const r = await bawSend(call)
    if (!r.ok || !r.txHash) return log('sell_failed', { ...info, stage: r.stage, error: r.error || r.status })
    const rc = await this.client.waitForTransactionReceipt({ hash: r.txHash, timeout: 90_000 })
    if (rc.status !== 'success') return log('sell_reverted', { ...info, txHash: r.txHash })
    const [qAfter, held] = await Promise.all([balanceOf(this.client, pos.quote, this.me), balanceOf(this.client, pos.token, this.me)])
    const got = qAfter - qBefore
    const next = {
      ...pos,
      remaining: held.toString(),
      proceeds: (BigInt(pos.proceeds) + got).toString(),
      stepsDone: step ? step : pos.stepsDone,
      sells: [...pos.sells, { at: Date.now(), amount: amount.toString(), got: got.toString(), venue: m.venue, txHash: r.txHash, reason }],
      ...(held === 0n && { status: 'closed', closedAt: Date.now(), closedReason: reason }),
    }
    this.persist(putPosition(this.state, next))
    log('sold', { ...info, got: fmt(got), txHash: r.txHash, pnl: fmt(BigInt(next.proceeds) - BigInt(next.cost)), closed: held === 0n })
    this.refreshFunds()
  }

  // ------------------------------------------------------------------ run
  /**
   * Resolve the pad: configured → re-verified; missing → discovered on-chain from the anchor bucket.
   * Returns the block to start listening from.
   */
  async resolvePad() {
    const net = this.cfg.net
    if (this.pad) {
      if (!net.v3Anchor) return (await this.client.getBlockNumber()) + 1n
      const fp = await fingerprintV3(this.client, this.pad, net)
      if (!fp.ok) {
        // a pad typed in by hand is the user's call; a discovered one must keep passing
        if (!this.cfg.pad) throw new Error(`stored V3 pad ${this.pad} no longer passes the fingerprint: ${fp.reasons.join('; ')}`)
        log('pad_warning', { pad: this.pad, reasons: fp.reasons })
      } else log('pad_verified', { pad: this.pad, tokenCount: fp.facts.tokenCount, owner: fp.facts.owner })
      return (await this.client.getBlockNumber()) + 1n
    }
    if (!this.cfg.autoDiscover || !net.v3Anchor) throw new Error('no V3 pad and auto-discovery is off')
    log('v3_waiting', { anchorBucket: net.v3Anchor.bucket, anchorOwner: net.v3Anchor.owner, how: 'first OperatorUpdated(x,true) on the bucket whose x passes the LaunchpadV3 fingerprint' })
    this.discovery = new AbortController()
    const fromBlock = this.state.discoverCursor?.[this.cfg.network] != null ? BigInt(this.state.discoverCursor[this.cfg.network]) : null
    const found = await discoverPad({
      client: this.client, net, fromBlock, signal: this.discovery.signal,
      // resume point across restarts: a sniper that was down < ~8h misses nothing
      onCursor: (c) => this.persist({ ...this.state, discoverCursor: { ...this.state.discoverCursor, [this.cfg.network]: c.toString() } }),
    })
    this.pad = found.pad
    this.cfg = { ...this.cfg, net: { ...net, pad: found.pad } }
    savePad(this.cfg.network, found.pad, { operatorTx: found.event.txHash, operatorBlock: found.event.blockNumber, owner: found.facts.owner, router: found.facts.router })
    log('v3_discovered', { pad: found.pad, operatorTx: found.event.txHash, block: found.event.blockNumber, router: found.facts.router, migrator: found.facts.migrator, owner: found.facts.owner, tokenCount: found.facts.tokenCount })
    if (this.canExecute && this.cfg.autoPrepare) {
      for (const q of quoteAddresses(this.cfg)) await this.approveQuote(q).catch((e) => log('approve_error', { quote: q, error: e.message }))
    }
    // Created events between the operator tx and now come back through the listener's backfill (stale ones skipped)
    return found.event.blockNumber
  }

  async start() {
    const fromBlock = await this.resolvePad()
    await this.refreshFunds()
    log('start', {
      network: this.cfg.network, pad: this.pad, wallet: this.me, dryRun: !this.canExecute, size: `${this.cfg.size}%`, exit: this.rule,
      quotes: quoteAddresses(this.cfg), funds: Object.fromEntries([...this.funds].map(([q, f]) => [q, { balance: fmt(f.balance), approved: f.allowance > maxUint256 / 2n ? 'max' : fmt(f.allowance) }])),
      openPositions: openPositions(this.state).length,
    })
    const urls = this.cfg.net.wss.split(',').map((s) => s.trim()).filter(Boolean)
    this.listener = listenCreated({
      urls, pad: this.pad, client: this.client, reconnectMs: this.cfg.reconnectMs, fromBlock,
      onCreated: (ev, meta) => this.onCreated(ev, meta).catch((e) => log('snipe_error', { token: ev.token, error: e.message })),
    })
    this.exitTimer = setInterval(() => this.checkExits(), this.cfg.pollExitSec * 1000)
    this.fundsTimer = setInterval(() => this.refreshFunds(), 30_000)
  }

  stop() {
    this.discovery?.abort()
    this.listener?.stop()
    clearInterval(this.exitTimer)
    clearInterval(this.fundsTimer)
  }
}

