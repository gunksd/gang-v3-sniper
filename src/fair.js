/**
 * 打新 (FairMintPad) strategy: on a new sale, mint the per-wallet cap at the sale's single price; approve the token for
 * PancakeSwap right after the mint (it is locked until launch, but approve is not a transfer); when the sale launches,
 * sell part of it on the pool; if the deadline passes unfilled, take the full refund.
 *
 * Planning is pure (planFairMint / sellPlan) and unit-tested; FairSniper does the I/O and shares the WBNB bankroll
 * (balances, in-flight reservations, allowances) with the V3 sniper it is attached to.
 */
import { decodeEventLog, decodeAbiParameters, encodeFunctionData, encodeEventTopics, getAddress, formatUnits, parseUnits, maxUint256 } from 'viem'
import { FAIR_ABI, FAIR_STATUS } from './abi.js'
import { balanceOf, allowance, poolAmountOut, calldata } from './chain.js'
import { bawSend, bawPreview, bawExecute } from './baw.js'
import { quoteAddresses, quoteKey } from './config.js'
import { listenCreated } from './listener.js'
import { log } from './log.js'

export const FAIR_TOKENS_PER_SHARE = 50_000n * 10n ** 18n
const BPS = 10_000n
const FAIR_TAX_BPS = 100n // FairToken.TAX_BPS: 1% on every pool buy / sell
const fmt = (x) => formatUnits(BigInt(x), 18)
const topicOf = (name) => encodeEventTopics({ abi: FAIR_ABI, eventName: name })[0]
export const FAIR_CREATED_TOPIC = topicOf('Created')
export const FAIR_LAUNCHED_TOPIC = topicOf('Launched')

const addr = (t) => getAddress(`0x${t.slice(26)}`)

/** Decode a FairMintPad Created log from topics/data. */
export function parseFairCreated(l) {
  if (l.topics?.[0]?.toLowerCase() !== FAIR_CREATED_TOPIC) return null
  const [name, symbol, logoURI, refPool, raiseBnb, sharePrice, capShares, deadline, holdBps, mintFeeBps, exitFeeBps] = decodeAbiParameters(
    ['string', 'string', 'string', 'address', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256'].map((type) => ({ type })), l.data,
  )
  return {
    token: addr(l.topics[1]), creator: addr(l.topics[2]), quote: addr(l.topics[3]),
    name, symbol, logoURI, refPool, raiseBnb, sharePrice, capShares, deadline, holdBps, mintFeeBps, exitFeeBps,
    blockNumber: BigInt(l.blockNumber), txHash: l.transactionHash, logIndex: Number(l.logIndex), removed: !!l.removed,
  }
}

export function parseFairLaunched(l) {
  if (l.topics?.[0]?.toLowerCase() !== FAIR_LAUNCHED_TOPIC) return null
  return { token: addr(l.topics[1]), pair: addr(l.topics[2]), blockNumber: BigInt(l.blockNumber), txHash: l.transactionHash, logIndex: Number(l.logIndex), removed: !!l.removed }
}

/**
 * Decide the mint for a new sale using only the event. → { shares, cost, fee, total, key } | { skip }
 * The sale price never moves, so the only race is the sale filling first: mint as many shares as the cap allows and
 * accept fewer if the last shares are being taken (minShares = 1).
 */
export function planFairMint(cfg, ev, state, nowSec = Math.floor(Date.now() / 1000)) {
  const f = cfg.fair
  if (!f.enabled) return { skip: 'fair_disabled' }
  const done = Object.keys(state.fair?.positions || {}).length
  if (done >= f.maxSales) return { skip: 'fair_max_sales', done, maxSales: f.maxSales }
  if (state.fair?.positions?.[ev.token.toLowerCase()]) return { skip: 'already_minted' }
  const quote = ev.quote.toLowerCase()
  if (!quoteAddresses(cfg).includes(quote)) return { skip: 'quote_not_selected', quote }
  if (BigInt(ev.deadline) <= BigInt(nowSec)) return { skip: 'sale_ended' }
  if (BigInt(ev.mintFeeBps) > BigInt(f.maxMintFeeBps)) return { skip: 'mint_fee_too_high', mintFeeBps: ev.mintFeeBps, max: f.maxMintFeeBps }

  const cap = BigInt(ev.capShares)
  const shares = f.shares === 'cap' ? cap : BigInt(f.shares)
  if (shares <= 0n) return { skip: 'zero_shares' }
  if (shares > cap) return { skip: 'shares_above_cap', shares, cap }
  const cost = shares * BigInt(ev.sharePrice)
  const fee = (cost * BigInt(ev.mintFeeBps)) / BPS
  const total = cost + fee
  const key = quoteKey(cfg, quote)
  const limit = f.maxSpend[key]
  if (limit == null) return { skip: 'no_fair_spend_limit_for_quote', quote }
  if (total > parseUnits(String(limit), 18)) return { skip: 'fair_max_spend', need: total, max: limit }
  return { quote, key, shares, minShares: 1n, cost, fee, total }
}

/**
 * How much to sell at launch. Hold line (HolderRewardHandler.eligibleShare): out for good once
 * balance × 10000 < baseline × holdBps, so with keepReward the balance must stay ≥ ceil(baseline × holdBps / 10000).
 */
export function sellPlan(balance, baseline, holdBps, sellPct, keepReward) {
  let amount = (balance * BigInt(sellPct)) / 100n
  let line = 0n
  if (keepReward && baseline > 0n) {
    line = (baseline * BigInt(holdBps) + BPS - 1n) / BPS
    const room = balance > line ? balance - line : 0n
    if (amount > room) amount = room
  }
  return { amount, line, keepsReward: !keepReward || balance - amount >= line }
}

/** Expected quote out for a pool sell of a FairToken: 1% stays with the token's tax handler, the rest hits the pair. */
export const intoPairAfterTax = (amount) => amount - (amount * FAIR_TAX_BPS) / BPS

export class FairSniper {
  /** core: the V3 Sniper (cfg, client, me, state persistence, shared bankroll) */
  constructor(core, pad) {
    this.core = core
    this.pad = pad
    this.busy = new Set()
  }

  get cfg() { return this.core.cfg }
  get client() { return this.core.client }
  get me() { return this.core.me }
  get state() { return this.core.state }
  fairState() { return this.state.fair || { positions: {} } }
  putFair(token, pos) {
    const fs = this.fairState()
    this.core.persist({ ...this.state, fair: { ...fs, positions: { ...fs.positions, [token.toLowerCase()]: pos } } })
  }

  async start(fromBlock) {
    const urls = this.cfg.net.wss.split(',').map((s) => s.trim()).filter(Boolean)
    // approve the pad up front (bounded: the per-sale limit × maxSales) so the first mint is a single tx
    if (this.core.canExecute) await this.approvePad().catch((e) => log('fair_approve_error', { error: e.message }))
    this.created = listenCreated({
      urls, pad: this.pad, client: this.client, reconnectMs: this.cfg.reconnectMs, fromBlock,
      topic: FAIR_CREATED_TOPIC, parse: parseFairCreated,
      onCreated: (ev, meta) => this.onCreated(ev, meta).catch((e) => log('fair_error', { token: ev.token, error: e.message })),
    })
    this.launched = listenCreated({
      urls, pad: this.pad, client: this.client, reconnectMs: this.cfg.reconnectMs, fromBlock,
      topic: FAIR_LAUNCHED_TOPIC, parse: parseFairLaunched,
      onCreated: (ev) => this.onLaunched(ev).catch((e) => log('fair_error', { token: ev.token, error: e.message })),
    })
    // the event stream is the fast path; this poll catches launches / failures the socket missed
    this.timer = setInterval(() => this.checkPositions(), this.cfg.pollExitSec * 1000)
    log('fair_watching', { pad: this.pad, maxSales: this.cfg.fair.maxSales, minted: Object.keys(this.fairState().positions).length, sellPctOnLaunch: this.cfg.fair.sellPctOnLaunch, keepReward: this.cfg.fair.keepReward })
  }

  stop() {
    this.created?.stop()
    this.launched?.stop()
    clearInterval(this.timer)
  }

  async approvePad() {
    for (const q of quoteAddresses(this.cfg)) {
      const limit = this.cfg.fair.maxSpend[quoteKey(this.cfg, q)]
      if (limit == null) continue
      const want = parseUnits(String(limit), 18) * BigInt(Math.max(1, this.cfg.fair.maxSales))
      const have = await allowance(this.client, q, this.me, this.pad)
      if (have >= want) continue
      const r = await bawSend({ from: this.me, to: q, data: calldata.approve(this.pad, want), chainId: this.cfg.net.bawChainId })
      if (!r.ok || !r.txHash) throw new Error(`approve ${q} → fair pad: ${JSON.stringify(r.error || r.status)}`)
      await this.client.waitForTransactionReceipt({ hash: r.txHash, timeout: 90_000 })
      log('fair_pad_approved', { quote: q, pad: this.pad, amount: fmt(want), txHash: r.txHash })
    }
  }

  // ------------------------------------------------------------------ mint
  async onCreated(ev, meta) {
    const base = { token: ev.token, symbol: ev.symbol, creator: ev.creator, quote: ev.quote, block: ev.blockNumber, source: meta.source }
    log('fair_created', {
      ...base, name: ev.name, raiseBnb: fmt(ev.raiseBnb), sharePrice: fmt(ev.sharePrice), capShares: ev.capShares,
      deadline: new Date(Number(ev.deadline) * 1000).toISOString(), holdPct: Number(ev.holdBps) / 100,
      mintFeePct: Number(ev.mintFeeBps) / 100, exitFeePct: Number(ev.exitFeeBps) / 100,
    })
    const plan = planFairMint(this.cfg, ev, this.state)
    if (plan.skip) return log('fair_skip', { ...base, reason: plan.skip, ...plan })

    const funds = this.core.available(plan.quote)
    const planLog = { ...base, shares: plan.shares, cost: fmt(plan.cost), fee: fmt(plan.fee), total: fmt(plan.total) }
    if (!this.core.canExecute) return log('fair_dry_run_mint', { ...planLog, ...(funds && funds.balance < plan.total && { fundsIssue: `have ${fmt(funds.balance)}` }) })
    if (funds && funds.balance < plan.total) return log('fair_skip', { ...base, reason: 'insufficient_quote', need: fmt(plan.total), have: fmt(funds.balance) })

    // reserve the slot before any await: maxSales counts it, and a second copy of the event can't mint again
    this.putFair(ev.token, { token: ev.token, symbol: ev.symbol, quote: ev.quote, pad: this.pad, status: 'minting', planned: plan.shares.toString(), holdBps: Number(ev.holdBps), deadline: Number(ev.deadline), at: Date.now() })
    this.core.reserve(plan.quote, plan.total)
    const release = () => this.core.release(plan.quote, plan.total)
    try {
      const data = encodeFunctionData({ abi: FAIR_ABI, functionName: 'mint', args: [ev.token, plan.shares, plan.minShares] })
      const p = await bawPreview({ from: this.me, to: this.pad, data, chainId: this.cfg.net.bawChainId })
      const fail = (stage, error) => {
        // free the slot again: nothing was minted
        const fs = this.fairState(); const { [ev.token.toLowerCase()]: _, ...rest } = fs.positions
        this.core.persist({ ...this.state, fair: { ...fs, positions: rest } })
        return log('fair_mint_failed', { ...planLog, stage, error })
      }
      if (!p.ok) return fail('preview', p.error)
      if (!p.simulationOk) return fail('simulation', p.simulationError)
      if (p.requireConfirmation) return fail('confirmation', 'risk engine requires App confirmation')
      const e = await bawExecute(p.requestId)
      if (!e.ok || !e.txHash) return fail('execute', e.error || e.status)
      log('fair_mint_sent', { ...planLog, txHash: e.txHash })
      await this.confirmMint(ev, plan, e.txHash)
    } finally {
      release()
      this.core.refreshFunds()
    }
  }

  async confirmMint(ev, plan, hash) {
    const r = await this.client.waitForTransactionReceipt({ hash, timeout: 90_000 })
    if (r.status !== 'success') {
      log('fair_mint_reverted', { token: ev.token, txHash: hash })
      const fs = this.fairState(); const { [ev.token.toLowerCase()]: _, ...rest } = fs.positions
      return this.core.persist({ ...this.state, fair: { ...fs, positions: rest } })
    }
    let minted = null
    let launchedInTx = null
    for (const l of r.logs) {
      if (l.address.toLowerCase() !== this.pad.toLowerCase()) continue
      try {
        const d = decodeEventLog({ abi: FAIR_ABI, ...l })
        if (d.eventName === 'Minted' && d.args.user.toLowerCase() === this.me.toLowerCase()) minted = d.args
        if (d.eventName === 'Launched' && d.args.token.toLowerCase() === ev.token.toLowerCase()) launchedInTx = d.args
      } catch { /* other event */ }
    }
    if (!minted) return log('fair_confirm_error', { token: ev.token, txHash: hash, error: 'no Minted event for this wallet' })
    const pos = {
      ...this.fairState().positions[ev.token.toLowerCase()],
      status: launchedInTx ? 'launched' : 'minted',
      shares: minted.userShares.toString(), tokens: (minted.userShares * FAIR_TOKENS_PER_SHARE).toString(),
      cost: minted.cost.toString(), fee: minted.fee.toString(), mintTx: hash, mintBlock: r.blockNumber.toString(),
      soldAtMint: minted.sold.toString(), ...(launchedInTx && { pair: launchedInTx.pair }),
    }
    this.putFair(ev.token, pos)
    log('fair_minted', { token: ev.token, symbol: ev.symbol, shares: minted.shares, tokens: fmt(pos.tokens), cost: fmt(minted.cost), fee: fmt(minted.fee), saleProgress: `${minted.sold}/10000`, txHash: hash })
    // approve the token for the Pancake router now, so the launch-time sell is one tx (approve works while locked)
    await this.approveRouter(ev.token).catch((err) => log('fair_approve_error', { token: ev.token, error: err.message }))
    // our mint filled the sale: it launched in the same tx
    if (launchedInTx) await this.onLaunched({ token: ev.token, pair: launchedInTx.pair })
  }

  async approveRouter(token) {
    const router = this.cfg.net.router
    if ((await allowance(this.client, token, this.me, router)) > maxUint256 / 2n) return
    const r = await bawSend({ from: this.me, to: token, data: calldata.approve(router), chainId: this.cfg.net.bawChainId })
    if (!r.ok || !r.txHash) throw new Error(`approve ${token} → router: ${JSON.stringify(r.error || r.status)}`)
    await this.client.waitForTransactionReceipt({ hash: r.txHash, timeout: 90_000 })
    log('fair_token_approved', { token, spender: router, txHash: r.txHash })
  }

  // ------------------------------------------------------------------ launch / refund
  async onLaunched(ev) {
    const key = ev.token.toLowerCase()
    const pos = this.fairState().positions[key]
    if (!pos || pos.launchSold || this.busy.has(key)) return
    if (pos.status === 'minting') return // our mint is still confirming; confirmMint picks the launch up
    this.busy.add(key)
    try {
      this.putFair(ev.token, { ...pos, status: 'launched', pair: ev.pair || pos.pair })
      log('fair_launched', { token: ev.token, symbol: pos.symbol, pair: ev.pair })
      await this.sellOnLaunch(this.fairState().positions[key])
    } finally {
      this.busy.delete(key)
    }
  }

  async sellOnLaunch(pos) {
    const f = this.cfg.fair
    if (!(f.sellPctOnLaunch > 0)) return this.putFair(pos.token, { ...pos, launchSold: 'skipped (sellPctOnLaunch = 0)' })
    const [bal, baseline, holdBps] = await Promise.all([
      balanceOf(this.client, pos.token, this.me),
      this.client.readContract({ address: this.pad, abi: FAIR_ABI, functionName: 'baselineOf', args: [pos.token, this.me] }),
      this.client.readContract({ address: this.pad, abi: FAIR_ABI, functionName: 'holdBpsOf', args: [pos.token] }),
    ])
    const plan = sellPlan(bal, baseline, holdBps, f.sellPctOnLaunch, f.keepReward)
    const info = { token: pos.token, symbol: pos.symbol, balance: fmt(bal), sell: fmt(plan.amount), holdLine: fmt(plan.line), holdPct: Number(holdBps) / 100, keepsReward: plan.keepsReward }
    if (plan.amount === 0n) return log('fair_sell_skipped', { ...info, reason: f.keepReward ? 'nothing above the hold line' : 'zero amount' })
    const path = [pos.token, pos.quote]
    const expected = await poolAmountOut(this.client, this.cfg.net.router, intoPairAfterTax(plan.amount), path)
    const minOut = expected - (expected * BigInt(Math.round(f.sellSlippagePct * 100))) / BPS
    if (!this.core.canExecute) return log('fair_dry_run_sell', { ...info, expected: fmt(expected), minOut: fmt(minOut) })

    await this.approveRouter(pos.token)
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300)
    const qBefore = await balanceOf(this.client, pos.quote, this.me)
    const r = await bawSend({ from: this.me, to: this.cfg.net.router, data: calldata.poolSell(plan.amount, minOut, path, this.me, deadline), chainId: this.cfg.net.bawChainId })
    if (!r.ok || !r.txHash) return log('fair_sell_failed', { ...info, stage: r.stage, error: r.error || r.status })
    const rc = await this.client.waitForTransactionReceipt({ hash: r.txHash, timeout: 90_000 })
    if (rc.status !== 'success') return log('fair_sell_reverted', { ...info, txHash: r.txHash })
    const got = (await balanceOf(this.client, pos.quote, this.me)) - qBefore
    this.putFair(pos.token, { ...this.fairState().positions[pos.token.toLowerCase()], launchSold: plan.amount.toString(), launchProceeds: got.toString(), launchSellTx: r.txHash })
    const paid = BigInt(pos.cost) + BigInt(pos.fee)
    log('fair_sold_on_launch', { ...info, got: fmt(got), paidForAll: fmt(paid), txHash: r.txHash })
    this.core.refreshFunds()
  }

  async checkPositions() {
    for (const pos of Object.values(this.fairState().positions)) {
      if (pos.status !== 'minted' || this.busy.has(pos.token.toLowerCase())) continue
      try {
        const st = FAIR_STATUS[Number(await this.client.readContract({ address: this.pad, abi: FAIR_ABI, functionName: 'status', args: [pos.token] }))]
        if (st === 'Launched') {
          const sale = await this.client.readContract({ address: this.pad, abi: FAIR_ABI, functionName: 'sales', args: [pos.token] })
          await this.onLaunched({ token: pos.token, pair: sale[13] })
        } else if (st === 'Failed' && this.cfg.fair.autoRefund) {
          await this.refund(pos)
        }
      } catch (e) {
        log('fair_check_error', { token: pos.token, error: e.shortMessage || e.message })
      }
    }
  }

  async refund(pos) {
    const key = pos.token.toLowerCase()
    this.busy.add(key)
    try {
      const data = encodeFunctionData({ abi: FAIR_ABI, functionName: 'refund', args: [pos.token] })
      if (!this.core.canExecute) return log('fair_dry_run_refund', { token: pos.token })
      const r = await bawSend({ from: this.me, to: this.pad, data, chainId: this.cfg.net.bawChainId })
      if (!r.ok || !r.txHash) return log('fair_refund_failed', { token: pos.token, stage: r.stage, error: r.error || r.status })
      const rc = await this.client.waitForTransactionReceipt({ hash: r.txHash, timeout: 90_000 })
      if (rc.status !== 'success') return log('fair_refund_reverted', { token: pos.token, txHash: r.txHash })
      this.putFair(pos.token, { ...pos, status: 'refunded', refundTx: r.txHash })
      log('fair_refunded', { token: pos.token, symbol: pos.symbol, amount: fmt(BigInt(pos.cost) + BigInt(pos.fee)), txHash: r.txHash })
      this.core.refreshFunds()
    } finally {
      this.busy.delete(key)
    }
  }
}

