import { describe, it, expect, vi } from 'vitest'

process.env.SNIPER_DATA_DIR = '/tmp/gang-sniper-unit-fair'
const { loadConfig } = await import('../src/config.js')
const { planFairMint, sellPlan, intoPairAfterTax, parseFairCreated, FAIR_CREATED_TOPIC, FAIR_TOKENS_PER_SHARE } = await import('../src/fair.js')

const E18 = 10n ** 18n
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
const cfgWith = (fair = {}, o = {}) => loadConfig({ network: 'mainnet', pad: '0x' + 'f'.repeat(40), fair, ...o })
const empty = () => ({ positions: {}, sniped: {}, daily: { date: 'x', spent: {}, perCreator: {} }, fair: { positions: {} } })
// default sale: raise 15 BNB → 0.0015 per share, cap 0.5% = 100 shares, 1% mint fee, hold 50%
const sale = (o = {}) => ({ token: '0x' + '1'.repeat(40), creator: '0x' + '2'.repeat(40), quote: WBNB, raiseBnb: 15n * E18, sharePrice: 15n * E18 / 10_000n, capShares: 100n, deadline: BigInt(Math.floor(Date.now() / 1000) + 3600), holdBps: 5000n, mintFeeBps: 100n, exitFeeBps: 100n, ...o })

describe('planFairMint', () => {
  it('mints the full cap: 100 shares × 0.0015 + 1% = 0.1515 WBNB', () => {
    const p = planFairMint(cfgWith(), sale(), empty())
    expect(p.shares).toBe(100n)
    expect(p.minShares).toBe(1n) // take the last shares if the sale is nearly full: filling it launches it
    expect(p.cost).toBe(15n * E18 / 100n)
    expect(p.fee).toBe(15n * E18 / 10_000n)
    expect(Number(p.total) / 1e18).toBeCloseTo(0.1515, 6)
  })

  it('worst case the contract allows (raise 50 BNB, cap 0.5%, 5% fee) = 0.525, inside the 0.6 default limit', () => {
    const p = planFairMint(cfgWith(), sale({ raiseBnb: 50n * E18, sharePrice: 50n * E18 / 10_000n, mintFeeBps: 500n }), empty())
    expect(Number(p.total) / 1e18).toBeCloseTo(0.525, 6)
  })

  it('maxSales: only the first sale by default, a second one is skipped', () => {
    const st = { ...empty(), fair: { positions: { ['0x' + '9'.repeat(40)]: { status: 'minted' } } } }
    expect(planFairMint(cfgWith(), sale(), st).skip).toBe('fair_max_sales')
    expect(planFairMint(cfgWith({ maxSales: 2 }), sale(), st).shares).toBe(100n)
  })

  it('skips: other quote, ended sale, fee above limit, over budget, disabled', () => {
    expect(planFairMint(cfgWith(), sale({ quote: '0x55d398326f99059fF775485246999027B3197955' }), empty()).skip).toBe('quote_not_selected')
    expect(planFairMint(cfgWith(), sale({ deadline: 1n }), empty()).skip).toBe('sale_ended')
    expect(planFairMint(cfgWith({ maxMintFeeBps: 200 }), sale({ mintFeeBps: 300n }), empty()).skip).toBe('mint_fee_too_high')
    expect(planFairMint(cfgWith({ maxSpend: { wbnb: '0.1' } }), sale(), empty()).skip).toBe('fair_max_spend')
    expect(planFairMint(cfgWith({ enabled: false }), sale(), empty()).skip).toBe('fair_disabled')
  })
})

describe('sellPlan (launch sell vs hold line)', () => {
  const baseline = 100n * FAIR_TOKENS_PER_SHARE // 5,000,000 tokens
  it('hold 50%: selling exactly half keeps the reward (balance × 1e4 ≥ baseline × holdBps)', () => {
    const p = sellPlan(baseline, baseline, 5000, 50, true)
    expect(p.amount).toBe(baseline / 2n)
    expect(p.keepsReward).toBe(true)
    expect((baseline - p.amount) * 10_000n >= baseline * 5000n).toBe(true)
  })
  it('hold 80%: keepReward caps the sale at 20%', () => {
    const p = sellPlan(baseline, baseline, 8000, 50, true)
    expect(p.amount).toBe(baseline / 5n)
    expect(p.keepsReward).toBe(true)
  })
  it('keepReward off: sells the full half even if it drops out of the reward', () => {
    const p = sellPlan(baseline, baseline, 8000, 50, false)
    expect(p.amount).toBe(baseline / 2n)
  })
  it('pool sell: 1% stays as tax, 99% reaches the pair', () => {
    expect(intoPairAfterTax(10_000n)).toBe(9_900n)
  })
})

describe('parseFairCreated', () => {
  it('decodes the real testnet RFT sale (FairMintPad 0x5ef1…, block 139052…)', async () => {
    const { createPublicClient, http } = await import('viem')
    const { bscTestnet } = await import('viem/chains')
    if (!process.env.TESTNET_IT) return
    const c = createPublicClient({ chain: bscTestnet, transport: http('https://bsc-testnet-rpc.publicnode.com') })
    const logs = await c.getLogs({ address: '0x5ef164cc3A812a5892Ed6ab33e7754339dFcA1d7', fromBlock: 139051953n, toBlock: 139056953n })
    const ev = logs.map(parseFairCreated).find(Boolean)
    expect(ev.symbol).toBe('RFT')
    expect(ev.capShares).toBe(100n)
    expect(ev.sharePrice).toBe(5n * E18 / 10_000n)
    expect(logs.find((l) => l.topics[0] === FAIR_CREATED_TOPIC)).toBeTruthy()
  })
})
