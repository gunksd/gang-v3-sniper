import { describe, it, expect } from 'vitest'
import { freshCurve, simulateBuy, simulateSell, afterBuy, grossForTokens, MAX_PER_WALLET, pctOfSupply, progressPct } from '../src/curve.js'

const E18 = 10n ** 18n
const GRAD = 15n * E18

// Ground truth: BSC testnet LaunchpadV3 0xFFE9…4395, token V3T (buy 2% / sell 2%), Buy events from
// docs/TESTNET-LAUNCHPAD-V3-2026-10-26.md run. Event quoteIn = net into curve.
const ONCHAIN = [
  { net: 47318611987381705n, protocolFee: 487820742137955n, tax: 975641484275912n, realQuoteAfter: 47318611987381705n },
]

describe('curve math matches LaunchpadV3 on-chain', () => {
  it('first 1% buy on a fresh 2%-tax curve equals the testnet Buy event to the wei', () => {
    const c = freshCurve(GRAD, 200, 200)
    const s = simulateBuy(c, 100n * E18) // oversized → capped at 1%, rest refunded
    expect(s.tokensOut).toBe(MAX_PER_WALLET)
    expect(s.net).toBe(ONCHAIN[0].net)
    expect(s.fee).toBe(ONCHAIN[0].protocolFee + ONCHAIN[0].tax)
    expect(s.capped).toBe(true)
    expect(s.spent + s.refund).toBe(100n * E18)
  })

  it('later buys: realQuote 71315372424722664 → 120000000000000001 matches with 10M out', () => {
    // state after buyer 2 (event realQuote 71315372424722664); sold = 5M (deployer kept half) + 10M
    const c = { ...freshCurve(GRAD, 200, 200), realQuote: 71315372424722664n, sold: 15_000_000n * E18 }
    const s = simulateBuy(c, 1n * E18)
    expect(s.tokensOut).toBe(MAX_PER_WALLET)
    expect(c.realQuote + s.net).toBe(120000000000000001n)
  })

  it('grossForTokens buys the exact target (no cap needed) for 0.25/0.5/0.75/1%', () => {
    const c = freshCurve(GRAD, 200, 200)
    for (const bps of [25, 50, 75, 100]) {
      const target = pctOfSupply(bps)
      const gross = grossForTokens(c, target)
      const s = simulateBuy(c, gross)
      expect(s.tokensOut >= target).toBe(true)
      // one wei less of gross must not give more tokens than target + rounding
      expect(s.tokensOut - target < 10n ** 12n).toBe(true)
    }
  })

  it('wallet cap: holder of 1% gets nothing, holder of 0.5% gets at most 0.5% more', () => {
    const c = freshCurve(GRAD, 200, 200)
    expect(simulateBuy(c, E18, MAX_PER_WALLET).tokensOut).toBe(0n)
    const s = simulateBuy(c, E18, MAX_PER_WALLET / 2n)
    expect(s.tokensOut).toBe(MAX_PER_WALLET / 2n)
  })

  it('graduation clamps net to the remaining amount and flags graduates', () => {
    const c = { ...freshCurve(GRAD, 200, 200), realQuote: GRAD - E18 / 100n, sold: 790_000_000n * E18 }
    const s = simulateBuy(c, E18, 0n, false)
    expect(s.net).toBe(E18 / 100n)
    expect(s.graduates).toBe(true)
    expect(s.refund > 0n).toBe(true)
  })

  it('sell pays 1% fee + sell tax; round trip loses ~ (3% + 3%) plus curve impact', () => {
    const c = freshCurve(GRAD, 200, 200)
    const b = simulateBuy(c, 100n * E18)
    const c2 = afterBuy(c, b)
    const s = simulateSell(c2, b.tokensOut)
    expect(s.quoteOut).toBe(b.net) // exact inverse on the curve (rounding up to 1 wei)
    const loss = Number(b.spent - s.toUser) / Number(b.spent)
    expect(loss).toBeGreaterThan(0.058)
    expect(loss).toBeLessThan(0.061)
  })

  it('progressPct', () => {
    expect(progressPct({ realQuote: GRAD / 2n, gradAmt: GRAD })).toBe(50)
  })
})
