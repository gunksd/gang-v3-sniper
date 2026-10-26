import { describe, it, expect, beforeAll } from 'vitest'
import { parseUnits } from 'viem'

process.env.SNIPER_DATA_DIR = '/tmp/gang-sniper-test-data'
const { loadConfig, DEFAULTS, EXIT_PRESETS } = await import('../src/config.js')
const { planBuy, checkTax, evaluateExit, multipleOf } = await import('../src/strategy.js')
const { freshCurve, simulateBuy, pctOfSupply, MAX_PER_WALLET } = await import('../src/curve.js')
const { parseCreated } = await import('../src/chain.js')

const E18 = 10n ** 18n
const PAD = '0xFFE9a823FbA62d0a77d4f8bB83965299b5664395'
const WBNB_T = '0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd'
const emptyState = () => ({ positions: {}, sniped: {}, daily: { date: 'x', spent: {}, perCreator: {} } })
const cfgWith = (o = {}) => loadConfig({ network: 'testnet', pad: PAD, ...o })
const ev = (o = {}) => ({ token: '0x' + '1'.repeat(40), creator: '0x' + '2'.repeat(40), quote: WBNB_T, gradAmt: 15n * E18, ...o })

describe('parseCreated', () => {
  it('decodes the real testnet V3T Created log (quote from topics[3])', () => {
    // block 139006834, tx 0x292e…1b7f
    const log = {
      topics: [
        '0x416fe98c8f1ea2977674a1a4ee6252eb72597a8392fc2d7d0599a2bf5d8fdb63',
        '0x000000000000000000000000e01f90c2a78810381ecfa2d62c050f32212e08b6',
        '0x000000000000000000000000ca8e63434072b40d3dfe6f5e7fd885f93a3200b6',
        '0x00000000000000000000000002b3de73af2c1f99c7efbdb65bcb960aacf4cf1c',
      ],
      // abi.encode("V3 Tax Test","V3T","",address(0),15e18)
      data: '0x00000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000e000000000000000000000000000000000000000000000000000000000000001200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000d02ab486cedc0000000000000000000000000000000000000000000000000000000000000000000b5633205461782054657374000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000356335400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
      blockNumber: '0x8491372', logIndex: '0x4', transactionHash: '0x292e0e10dcf968a4949cb1fc43c70db2b3df2d51791f0dafd0b33a69d24e1b7f',
    }
    const e = parseCreated(log)
    expect(e.token).toBe('0xe01F90c2A78810381ecfa2d62c050f32212E08B6')
    expect(e.creator).toBe('0xCa8e63434072B40d3dFE6f5e7Fd885F93A3200b6')
    expect(e.quote).toBe('0x02B3dE73aF2c1F99c7EFbDb65bcB960AACF4CF1c')
    expect(e.symbol).toBe('V3T')
    expect(e.name).toBe('V3 Tax Test')
    expect(e.gradAmt).toBe(15n * E18)
    expect(e.blockNumber).toBe(139006834n)
  })
  it('ignores other topics', () => {
    expect(parseCreated({ topics: ['0xdead'], data: '0x' })).toBe(null)
  })
})

describe('planBuy', () => {
  it('buys only selected quotes', () => {
    const p = planBuy(cfgWith(), ev({ quote: '0x02B3dE73aF2c1F99c7EFbDb65bcB960AACF4CF1c' }), emptyState())
    expect(p.skip).toBe('quote_not_selected')
  })

  it.each([['0.25', 25], ['0.5', 50], ['0.75', 75], ['1', 100]])('size %s%% → buys at least the target with worst-case tax', (size, bps) => {
    const cfg = cfgWith({ size, maxSpendQuote: { wbnb: '1', usdt: '1' }, dailyBudgetQuote: { wbnb: '10', usdt: '10' } })
    const p = planBuy(cfg, ev(), emptyState())
    expect(p.skip).toBeUndefined()
    expect(p.sizeBps).toBe(bps)
    const target = pctOfSupply(bps)
    // real token taxed at 2% (≤ assumed max 3%): the same quoteIn still buys ≥ target, capped at 1%
    const s = simulateBuy(freshCurve(15n * E18, 200, 200), p.quoteIn)
    expect(s.tokensOut >= target).toBe(true)
    expect(s.tokensOut <= MAX_PER_WALLET).toBe(true)
    expect(s.tokensOut >= p.minTokensOut).toBe(true)
  })

  it('1% at open costs ≈0.049 WBNB at 2% tax; plan includes slippage headroom (contract refunds the rest)', () => {
    const cfg = cfgWith({ size: '1' })
    const p = planBuy(cfg, ev(), emptyState())
    const s = simulateBuy(freshCurve(15n * E18, 200, 200), p.quoteIn)
    expect(s.tokensOut).toBe(MAX_PER_WALLET)
    expect(Number(s.spent) / 1e18).toBeCloseTo(0.04878, 4)
    expect(s.refund > 0n).toBe(true)
  })

  it('respects max spend, daily budget, dedupe and per-creator limit', () => {
    expect(planBuy(cfgWith({ maxSpendQuote: { wbnb: '0.01', usdt: '1' } }), ev(), emptyState()).skip).toBe('max_spend_below_size')
    const spent = { ...emptyState(), daily: { date: 'x', spent: { wbnb: parseUnits('0.49', 18).toString() }, perCreator: {} } }
    expect(planBuy(cfgWith(), ev(), spent).skip).toBe('daily_budget')
    const sniped = { ...emptyState(), sniped: { [ev().token.toLowerCase()]: {} } }
    expect(planBuy(cfgWith(), ev(), sniped).skip).toBe('already_sniped')
    const busy = { ...emptyState(), daily: { date: 'x', spent: {}, perCreator: { [ev().creator.toLowerCase()]: 2 } } }
    expect(planBuy(cfgWith(), ev(), busy).skip).toBe('creator_daily_limit')
    expect(planBuy(cfgWith({ skipCreators: [ev().creator] }), ev(), emptyState()).skip).toBe('creator_blacklisted')
  })

  it('checkTax rejects taxes above the limits', () => {
    const cfg = cfgWith({ maxBuyTaxBps: 200, maxSellTaxBps: 200 })
    expect(checkTax(cfg, { buyTaxBps: 200n, sellTaxBps: 200n, graduated: false })).toBe(null)
    expect(checkTax(cfg, { buyTaxBps: 300n, sellTaxBps: 200n, graduated: false })).toMatch(/buy tax/)
    expect(checkTax(cfg, { buyTaxBps: 200n, sellTaxBps: 500n, graduated: false })).toMatch(/sell tax/)
  })
})

describe('evaluateExit', () => {
  const pos = { tokens: (10n * E18).toString(), remaining: (10n * E18).toString(), cost: E18.toString(), openedAt: 0, stepsDone: 0 }
  const mark = (valueX, o = {}) => ({ value: BigInt(Math.round(valueX * 1e6)) * 10n ** 12n, progressPct: 10, graduated: false, now: 60_000, ...o })
  const rule = (k, o = {}) => ({ ...EXIT_PRESETS[k], ...o })

  it('multiple: holds below target, sells all at target', () => {
    expect(evaluateExit(rule('x2'), pos, mark(1.9)).action).toBe('hold')
    const d = evaluateExit(rule('x2'), pos, mark(2.01))
    expect(d).toMatchObject({ action: 'sell', venue: 'curve', amount: 10n * E18 })
  })

  it('stop loss and time stop apply to every rule', () => {
    expect(evaluateExit(rule('x2'), pos, mark(0.49)).reason).toMatch(/stop loss/)
    expect(evaluateExit(rule('x2'), pos, mark(1.2, { now: 361 * 60_000 })).reason).toMatch(/time stop/)
    expect(evaluateExit(rule('graduate'), pos, mark(0.3)).action).toBe('hold') // graduate preset: no stop loss
  })

  it('ladder sells step slices of the original size, last step sells the rest', () => {
    const r = rule('ladder')
    const d1 = evaluateExit(r, pos, mark(2.1))
    expect(d1).toMatchObject({ action: 'sell', amount: 5n * E18, step: 1 })
    const after1 = { ...pos, remaining: (5n * E18).toString(), stepsDone: 1 }
    // value is for the remaining 5 tokens; multiple is per token vs cost/10 tokens
    expect(evaluateExit(r, after1, mark(1.9)).action).toBe('hold') // 3.8x < 4x
    expect(evaluateExit(r, after1, mark(2.05))).toMatchObject({ action: 'sell', step: 2, amount: 25n * E18 / 10n }) // 4.1x
    const after2 = { ...pos, remaining: (25n * E18 / 10n).toString(), stepsDone: 2 }
    expect(evaluateExit(r, after2, mark(1.9)).action).toBe('hold') // 7.6x < 8x
    expect(evaluateExit(r, after2, mark(2.05))).toMatchObject({ action: 'sell', step: 3, amount: 25n * E18 / 10n }) // last step: all
  })

  it('progress and graduate rules', () => {
    expect(evaluateExit(rule('progress50'), pos, mark(1.5, { progressPct: 49 })).action).toBe('hold')
    expect(evaluateExit(rule('progress50'), pos, mark(1.5, { progressPct: 50 })).action).toBe('sell')
    expect(evaluateExit(rule('graduate'), pos, mark(5)).action).toBe('hold')
    expect(evaluateExit(rule('graduate'), pos, mark(5, { graduated: true }))).toMatchObject({ action: 'sell', venue: 'pool' })
  })

  it('manual never sells', () => {
    expect(evaluateExit(rule('manual'), pos, mark(100)).action).toBe('hold')
  })

  it('multipleOf is per-token so it survives partial sells', () => {
    expect(multipleOf(pos, 2n * E18)).toBe(2)
    expect(multipleOf({ ...pos, remaining: (5n * E18).toString() }, E18)).toBe(2)
  })
})

describe('config', () => {
  it('rejects bad size/exit; missing mainnet pad only when auto-discovery is off', () => {
    expect(() => loadConfig({ network: 'testnet', pad: PAD, size: '2' })).toThrow(/size/)
    expect(() => loadConfig({ network: 'testnet', pad: PAD, exit: 'nope' })).toThrow(/exit/)
    expect(() => loadConfig({ network: 'mainnet', autoDiscover: false })).toThrow(/SNIPER_PAD/)
    // default: no mainnet pad is fine, run waits for auto-discovery
    expect(loadConfig({ network: 'mainnet' }).net.pad).toBe(null)
    expect(loadConfig({ network: 'mainnet' }).net.v3Anchor.bucket).toBe('0xBDDd8F275D7Cb65f5454D0bEDf0463792878F111')
    expect(DEFAULTS.dryRun).toBe(true)
  })
})

describe('discovery scan window', () => {
  it('mainnet scans only the window public RPCs serve; resumes from a saved cursor inside it', async () => {
    const { discoverPad } = await import('../src/discover.js')
    const { NETWORKS } = await import('../src/config.js')
    const net = { ...NETWORKS.mainnet, pad: null }
    const ranges = []
    const head = 130_000_000n
    const client = {
      getBlockNumber: async () => head,
      getLogs: async ({ fromBlock, toBlock }) => { ranges.push([fromBlock, toBlock]); return [] },
      readContract: async () => '0x4EEdcDF5fab775e10C0D09951b6F59Ab81ba19d3', // anchor owner check
    }
    const run = async (fromBlock) => {
      ranges.length = 0
      const ctl = new AbortController()
      const p = discoverPad({ client, net, fromBlock, signal: ctl.signal, pollMs: 60_000 }).catch(() => {})
      await new Promise((r) => setTimeout(r, 50))
      ctl.abort(); await p
      return ranges
    }
    const fresh = await run(null)
    expect(fresh[0][0]).toBe(head - 3n - 9_000n)
    expect(fresh.at(-1)[1]).toBe(head - 3n) // stays behind the reported head
    const resumed = await run(head - 100n)
    expect(resumed[0][0]).toBe(head - 100n)
    const tooOld = await run(head - 50_000n) // e.g. down for days: clamp, never ask for archive blocks
    expect(tooOld[0][0]).toBe(head - 3n - 9_000n)
  })
})
