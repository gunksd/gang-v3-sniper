/**
 * Pure decision logic (no I/O): what to buy when a Created arrives, and when/how much to sell an open position.
 * Kept free of RPC so it is fully unit-tested and so the hot path does zero network calls before the preview.
 */
import { parseUnits } from 'viem'
import { freshCurve, grossForTokens, pctOfSupply, MAX_PER_WALLET, BPS } from './curve.js'
import { quoteAddresses, quoteKey, sizeBps } from './config.js'

const pctBig = (pct) => BigInt(Math.round(pct * 100)) // percent → bps
const mulBps = (x, bps) => (x * bps) / BPS

/**
 * Decide the buy for a fresh Created event using only event data + local state.
 * The curve at the event block is known exactly: realQuote = sold = 0, virtualQuote = gradAmt / 3.
 * The buy tax is NOT in Created, so quoteIn is sized for the worst tax we accept (maxBuyTaxBps); the real tax is
 * checked from curves() in parallel with the baw preview and the snipe is dropped before execute if it is higher.
 *
 * 1% (wallet cap): send target gross × (1 + slippage); the contract clamps tokensOut to the cap and refunds the
 *   rest, so other buyers landing first only cost more quote, bounded by slippage.
 * <1%: send exactly the gross for `target` and require minTokensOut = target × (1 − slippage).
 */
export function planBuy(cfg, ev, state) {
  const quote = ev.quote.toLowerCase()
  const allowed = quoteAddresses(cfg)
  if (!allowed.includes(quote)) return { skip: 'quote_not_selected', quote }
  const creator = ev.creator.toLowerCase()
  if (cfg.onlyCreators.length && !cfg.onlyCreators.map((a) => a.toLowerCase()).includes(creator)) return { skip: 'creator_not_whitelisted' }
  if (cfg.skipCreators.map((a) => a.toLowerCase()).includes(creator)) return { skip: 'creator_blacklisted' }
  if (state.sniped[ev.token.toLowerCase()]) return { skip: 'already_sniped' }
  if ((state.daily.perCreator[creator] || 0) >= cfg.maxPerCreatorPerDay) return { skip: 'creator_daily_limit' }
  if (ev.gradAmt === 0n) return { skip: 'bad_grad_amount' }

  const key = quoteKey(cfg, quote)
  const maxSpendHuman = cfg.maxSpendQuote[key]
  const budgetHuman = cfg.dailyBudgetQuote[key]
  if (maxSpendHuman == null || budgetHuman == null) return { skip: 'no_spend_limit_for_quote', quote }
  const maxSpend = parseUnits(String(maxSpendHuman), 18)
  const budgetLeft = parseUnits(String(budgetHuman), 18) - BigInt(state.daily.spent[key] || 0)

  const bps = sizeBps(cfg)
  const target = pctOfSupply(bps)
  const curve = freshCurve(ev.gradAmt, cfg.maxBuyTaxBps, cfg.maxSellTaxBps)
  const gross = grossForTokens(curve, target)
  const slip = pctBig(cfg.slippagePct)
  const full = target >= MAX_PER_WALLET

  let quoteIn = full ? gross + mulBps(gross, slip) : gross
  if (quoteIn > maxSpend) {
    // 1%: maxSpend still buys the cap if no one is ahead; below that it is not enough for the size at all
    if (maxSpend < gross) return { skip: 'max_spend_below_size', need: gross, maxSpend }
    quoteIn = maxSpend
  }
  if (quoteIn > budgetLeft) return { skip: 'daily_budget', need: quoteIn, left: budgetLeft }
  const minTokensOut = target - mulBps(target, slip)
  return { quote, key, sizeBps: bps, target, quoteIn, minTokensOut, expectedGross: gross, assumedBuyTaxBps: cfg.maxBuyTaxBps }
}

/** Real tax from curves() vs the configured limits. */
export function checkTax(cfg, curve) {
  if (curve.buyTaxBps > BigInt(cfg.maxBuyTaxBps)) return `buy tax ${curve.buyTaxBps} bps > max ${cfg.maxBuyTaxBps}`
  if (curve.sellTaxBps > BigInt(cfg.maxSellTaxBps)) return `sell tax ${curve.sellTaxBps} bps > max ${cfg.maxSellTaxBps}`
  if (curve.graduated) return 'already graduated'
  return null
}

/**
 * Price multiple of what is left, net of exit fees: (value of remaining / remaining) ÷ (cost / original).
 * Using per-token terms keeps the multiple comparable after partial (ladder) sells.
 */
export function multipleOf(pos, value) {
  const remaining = BigInt(pos.remaining)
  if (remaining === 0n) return 0
  const original = BigInt(pos.tokens)
  const cost = BigInt(pos.cost)
  if (cost === 0n) return 0
  return Number((value * original * 10_000n) / (remaining * cost)) / 10_000
}

/**
 * Exit decision for one position.
 * mark = { value (quote received if `remaining` were sold now, after fees), progressPct, graduated, now (ms) }
 * → { action: 'hold' } | { action: 'sell', amount (tokens, bigint), reason, venue: 'curve' | 'pool', step? }
 */
export function evaluateExit(rule, pos, mark) {
  const remaining = BigInt(pos.remaining)
  if (remaining === 0n) return { action: 'hold', reason: 'closed' }
  const venue = mark.graduated ? 'pool' : 'curve'
  const all = (reason) => ({ action: 'sell', amount: remaining, reason, venue })
  const mult = multipleOf(pos, mark.value)
  const ageMin = (mark.now - pos.openedAt) / 60_000

  if (rule.stopLossPct > 0 && mult <= 1 - rule.stopLossPct / 100) return all(`stop loss: ${mult.toFixed(3)}x`)
  if (rule.maxHoldMin > 0 && ageMin >= rule.maxHoldMin) return all(`time stop: ${Math.floor(ageMin)} min`)

  switch (rule.kind) {
    case 'multiple':
      if (mult >= rule.takeProfitX) return all(`take profit: ${mult.toFixed(3)}x ≥ ${rule.takeProfitX}x`)
      break
    case 'ladder': {
      const done = pos.stepsDone || 0
      const step = rule.steps[done]
      if (step && mult >= step.x) {
        const last = done === rule.steps.length - 1
        let amount = last ? remaining : (BigInt(pos.tokens) * BigInt(step.pct)) / 100n
        if (amount > remaining) amount = remaining
        return { action: 'sell', amount, reason: `ladder step ${done + 1}: ${mult.toFixed(3)}x ≥ ${step.x}x`, venue, step: done + 1 }
      }
      break
    }
    case 'progress':
      if (mark.graduated) return all('graduated before progress target')
      if (mark.progressPct >= rule.progressPct) return all(`progress ${mark.progressPct}% ≥ ${rule.progressPct}%`)
      break
    case 'graduate':
      if (mark.graduated) return all('graduated')
      break
    case 'manual':
    default:
      break
  }
  return { action: 'hold', mult }
}

/** Minimum out for an exit, from the expected amount and slippage. */
export const minOut = (expected, slippagePct) => expected - mulBps(expected, pctBig(slippagePct))
