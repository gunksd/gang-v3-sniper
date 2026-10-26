/**
 * Exact port of LaunchpadV3 bonding-curve math (_prepBuy / _applyFees / _recomputeFee / _tokensOut / _quoteInFor /
 * _quoteOut and sell). All bigint, same rounding as the contract, so quotes match on-chain results to the wei.
 */
export const TOTAL_SUPPLY = 1_000_000_000n * 10n ** 18n
export const VIRTUAL_TOKEN = 1_066_666_666_666_666_666_666_666_667n
export const MAX_PER_WALLET = 10_000_000n * 10n ** 18n // 1% of supply
export const BPS = 10_000n
export const PROTOCOL_FEE_BPS = 100n

const ceilDiv = (a, b) => (a === 0n ? 0n : (a - 1n) / b + 1n)

/** Fresh curve as written by _writeCurve: virtualQuote = gradAmt / 3, nothing sold. */
export function freshCurve(gradAmt, buyTaxBps = 0, sellTaxBps = 0) {
  return { realQuote: 0n, sold: 0n, gradAmt, virtualQuote: gradAmt / 3n, buyTaxBps: BigInt(buyTaxBps), sellTaxBps: BigInt(sellTaxBps), graduated: false }
}

export function tokensOut(c, quoteIn) {
  const k = c.virtualQuote * VIRTUAL_TOKEN
  const qReserve = c.virtualQuote + c.realQuote
  const tReserve = VIRTUAL_TOKEN - c.sold
  return tReserve - ceilDiv(k, qReserve + quoteIn)
}

export function quoteInFor(c, out) {
  const k = c.virtualQuote * VIRTUAL_TOKEN
  const qReserve = c.virtualQuote + c.realQuote
  const tReserve = VIRTUAL_TOKEN - c.sold
  return ceilDiv(k, tReserve - out) - qReserve
}

export function quoteOut(c, tokensIn) {
  const k = c.virtualQuote * VIRTUAL_TOKEN
  const qReserve = c.virtualQuote + c.realQuote
  const tReserve = VIRTUAL_TOKEN - c.sold
  return qReserve - ceilDiv(k, tReserve + tokensIn)
}

const feeBpsOf = (c) => PROTOCOL_FEE_BPS + c.buyTaxBps

function applyFees(gross, feeBps) {
  const protocolFee = (gross * PROTOCOL_FEE_BPS) / BPS
  const tax = (gross * feeBps) / BPS - protocolFee
  return { gross, protocolFee, tax, net: gross - protocolFee - tax }
}

/**
 * Simulate buy(token, quoteIn, ·) for a wallet that already holds `held` tokens.
 * → { tokensOut, spent (gross pulled and kept), refund, net (into curve), fee, graduates }
 */
export function simulateBuy(c, quoteIn, held = 0n, walletCap = true) {
  const room = held >= MAX_PER_WALLET ? 0n : MAX_PER_WALLET - held
  if (walletCap && room === 0n) return { tokensOut: 0n, spent: 0n, refund: quoteIn, net: 0n, fee: 0n, graduates: false, capped: true }
  const feeBps = feeBpsOf(c)
  let v = applyFees(quoteIn, feeBps)
  let refund = 0n
  const recompute = (net) => {
    let spent = ceilDiv(net * BPS, BPS - feeBps)
    if (spent > quoteIn) spent = quoteIn
    const r = applyFees(spent, feeBps)
    refund = quoteIn - spent
    return r
  }
  const remaining = c.gradAmt - c.realQuote
  if (v.net > remaining) {
    v = recompute(remaining)
    if (v.net > remaining) v = { ...v, net: remaining }
  }
  let out = tokensOut(c, v.net)
  if (walletCap && out > room) {
    out = room
    v = recompute(quoteInFor(c, room))
  }
  return {
    tokensOut: out, spent: quoteIn - refund, refund, net: v.net, fee: v.protocolFee + v.tax,
    graduates: c.realQuote + v.net >= c.gradAmt, capped: walletCap && out === room,
  }
}

/** Gross quote needed to buy exactly `target` tokens from curve `c` (fees included, rounded up). */
export function grossForTokens(c, target) {
  const net = quoteInFor(c, target)
  return ceilDiv(net * BPS, BPS - feeBpsOf(c))
}

/** Simulate sell(token, tokensIn, ·) → quote paid to the seller after the 1% protocol fee and the sell tax. */
export function simulateSell(c, tokensIn) {
  const out = quoteOut(c, tokensIn)
  const protocolFee = (out * PROTOCOL_FEE_BPS) / BPS
  const tax = (out * c.sellTaxBps) / BPS
  return { quoteOut: out, toUser: out - protocolFee - tax, fee: protocolFee + tax }
}

/** Apply a buy to the curve (what the chain state looks like after it lands). */
export function afterBuy(c, sim) {
  return { ...c, realQuote: c.realQuote + sim.net, sold: c.sold + sim.tokensOut, graduated: sim.graduates }
}

/** Spot price in quote per token, 18-dec fixed point. */
export function spotPrice(c) {
  return ((c.virtualQuote + c.realQuote) * 10n ** 18n) / (VIRTUAL_TOKEN - c.sold)
}

/** Progress to graduation in percent (number). */
export function progressPct(c) {
  return c.gradAmt === 0n ? 0 : Number((c.realQuote * 10000n) / c.gradAmt) / 100
}

export const pctOfSupply = (bps) => (TOTAL_SUPPLY * BigInt(bps)) / BPS
