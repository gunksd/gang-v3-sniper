import { describe, it, expect, vi, beforeEach } from 'vitest'
import { rmSync } from 'node:fs'

process.env.SNIPER_DATA_DIR = '/tmp/gang-sniper-unit-sniper'
rmSync(process.env.SNIPER_DATA_DIR, { recursive: true, force: true })

const sent = []
vi.mock('../src/baw.js', () => ({
  bawPreview: vi.fn(async () => ({ ok: true, requestId: 'r', simulationOk: true, requireConfirmation: false })),
  bawExecute: vi.fn(async () => { sent.push(1); return { ok: true, txHash: '0x' + String(sent.length).padStart(64, '0') } }),
  bawSend: vi.fn(async () => ({ ok: true, txHash: '0x' + 'a'.repeat(64) })),
  bawStatus: vi.fn(async () => 'CONNECTED'),
  bawSettings: vi.fn(async () => ({ devMode: { enabled: true } })),
}))

const { loadConfig } = await import('../src/config.js')
const { Sniper } = await import('../src/sniper.js')

const E18 = 10n ** 18n
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
const PAD = '0x' + 'f'.repeat(40)
const curve = [PAD, WBNB, 0n, 0n, 15n * E18, 5n * E18, false, 200, 200, 0, '0x' + '0'.repeat(40), '0x' + '0'.repeat(40)]
// receipts never arrive during the test: both buys stay in flight
const client = {
  readContract: vi.fn(async ({ functionName }) => (functionName === 'curves' ? curve : 0n)),
  waitForTransactionReceipt: () => new Promise(() => {}),
  getBlockNumber: async () => 100n,
  getBalance: async () => 0n,
}
const ev = (i) => ({ token: '0x' + String(i).padStart(40, '1'), creator: '0x' + String(i).padStart(40, '2'), quote: WBNB, gradAmt: 15n * E18, symbol: `T${i}`, blockNumber: 100n, txHash: '0x' + String(i).padStart(64, '3'), logIndex: 0 })

describe('Sniper in-flight accounting', () => {
  beforeEach(() => { sent.length = 0 })

  it('concurrent mode, 0.54 WBNB, two launches at once: first sends 0.5, second has only 0.04 left (< open cost) → skipped', async () => {
    const cfg = loadConfig({ network: 'mainnet', pad: PAD, dryRun: false, size: '1', buyQuoteIn: { wbnb: '0.5' }, dailyBudgetQuote: { wbnb: '1', usdt: '1' }, autoWrap: false, autoPrepare: false })
    const s = new Sniper({ cfg, client, me: '0x' + '9'.repeat(40) })
    s.funds.set(WBNB.toLowerCase(), { balance: 54n * E18 / 100n, allowance: 10n * E18 })
    await Promise.all([s.onCreated(ev(1), { source: 'test' }), s.onCreated(ev(2), { source: 'test' })])
    expect(sent.length).toBe(1)
    expect(s.inflight.get(WBNB.toLowerCase())).toBe(5n * E18 / 10n)
  })

  it('a failed preview gives the reservation back', async () => {
    const { bawPreview } = await import('../src/baw.js')
    bawPreview.mockResolvedValueOnce({ ok: false, error: 'boom' })
    const cfg = loadConfig({ network: 'mainnet', pad: PAD, dryRun: false, size: '1', buyQuoteIn: { wbnb: '0.5' }, dailyBudgetQuote: { wbnb: '1', usdt: '1' }, autoWrap: false, autoPrepare: false })
    const s = new Sniper({ cfg, client, me: '0x' + '9'.repeat(40) })
    s.funds.set(WBNB.toLowerCase(), { balance: E18, allowance: 10n * E18 })
    await s.onCreated(ev(3), { source: 'test' })
    expect(sent.length).toBe(0)
    expect(s.inflight.get(WBNB.toLowerCase())).toBe(0n)
  })
})

describe('auto-wrap guard', () => {
  const mk = (native, wbnb) => {
    const cfg = loadConfig({ network: 'mainnet', pad: PAD, dryRun: false, size: '1', buyQuoteIn: { wbnb: '0.5' }, autoPrepare: false })
    const c = { ...client, getBalance: async () => native, readContract: async () => wbnb }
    return new Sniper({ cfg, client: c, me: '0x' + '9'.repeat(40) })
  }
  it('does not wrap when BNB+WBNB cannot cover one 0.5 buy (keeps the gas)', async () => {
    const { bawSend } = await import('../src/baw.js')
    bawSend.mockClear()
    await mk(31n * E18 / 1000n, 0n).wrapNative()
    expect(bawSend).not.toHaveBeenCalled()
  })
  it('wraps everything above the 0.01 gas reserve once one buy is affordable', async () => {
    const { bawSend } = await import('../src/baw.js')
    bawSend.mockClear()
    const s = mk(6n * E18 / 10n, 0n)
    s.client.waitForTransactionReceipt = async () => ({ status: 'success' })
    await s.wrapNative()
    expect(bawSend).toHaveBeenCalledTimes(1)
    expect(bawSend.mock.calls[0][0].value).toBe(59n * E18 / 100n)
  })
})


const { bawPreview: previewMock } = await import('../src/baw.js')
describe('sequential queue: one at a time, refund first, first N tokens', () => {
  const bawPreview = previewMock
  const mkClient = (receiptDelayMs, refundTo) => {
    let balance
    return {
      setBalance: (b) => { balance = b },
      readContract: vi.fn(async ({ functionName }) => (functionName === 'curves' ? curve : functionName === 'balanceOf' ? balance : 10n * E18)),
      // the receipt: the pad kept 0.0488 of the 0.5, the refund is back
      waitForTransactionReceipt: async () => { await new Promise((r) => setTimeout(r, receiptDelayMs)); balance = refundTo(balance); return { status: 'success', logs: [], blockNumber: 101n } },
      getBlockNumber: async () => 100n,
      getBalance: async () => 0n,
    }
  }

  it('second token waits for the first receipt, then sends 0.5 again (not skipped)', async () => {
    // earlier tests leave receipts that never resolve: let their promises go before counting
    await new Promise((r) => setTimeout(r, 10))
    sent.length = 0
    bawPreview.mockClear()
    const c = mkClient(50, (b) => b - 488n * E18 / 10_000n)
    c.setBalance(554n * E18 / 1000n)
    const cfg = loadConfig({ network: 'mainnet', pad: PAD, dryRun: false, size: '1', buyQuoteIn: { wbnb: '0.5' }, dailyBudgetQuote: { wbnb: '1', usdt: '1' }, sequential: true, maxTokens: 10, autoWrap: false, autoPrepare: false })
    const s = new Sniper({ cfg, client: c, me: '0x' + '9'.repeat(40) })
    // fresh state: other tests in this file already bought tokens (per-creator limit, sniped set)
    s.state = { positions: {}, sniped: {}, daily: { date: new Date().toISOString().slice(0, 10), spent: {}, perCreator: {} }, fair: { positions: {} } }
    s.funds.set(WBNB.toLowerCase(), { balance: 554n * E18 / 1000n, allowance: 10n * E18 })
    s.onCreated(ev(11), { source: 'test' })
    s.onCreated(ev(12), { source: 'test' })
    await new Promise((r) => setTimeout(r, 20))
    expect(sent.length).toBe(1) // the second is queued, not sent and not skipped
    await new Promise((r) => setTimeout(r, 120))
    expect(sent.length).toBe(2)
    const sends = bawPreview.mock.calls.map(([call]) => call.data)
    // both sends carry quoteIn = 0.5 WBNB (buy(token, quoteIn, minOut) → 2nd word)
    for (const d of sends) expect(BigInt('0x' + d.slice(74, 138))).toBe(5n * E18 / 10n)
  })

  it('stops after maxTokens', async () => {
    const { planBuy } = await import('../src/strategy.js')
    const cfg = loadConfig({ network: 'mainnet', pad: PAD, size: '1', buyQuoteIn: { wbnb: '0.5' }, dailyBudgetQuote: { wbnb: '10', usdt: '1' }, maxTokens: 10 })
    const sniped = Object.fromEntries(Array.from({ length: 10 }, (_, i) => ['0x' + String(i).padStart(40, '5'), { dryRun: false }]))
    expect(planBuy(cfg, ev(99), { positions: {}, sniped, daily: { date: 'x', spent: {}, perCreator: {} } }).skip).toBe('max_tokens_reached')
    const nine = Object.fromEntries(Object.entries(sniped).slice(0, 9))
    expect(planBuy(cfg, ev(99), { positions: {}, sniped: nine, daily: { date: 'x', spent: {}, perCreator: {} } }).skip).toBeUndefined()
  })

  it('wallet below 0.5 sends what is left if it still buys 1% at open; below that skips', async () => {
    const { planBuy } = await import('../src/strategy.js')
    const cfg = loadConfig({ network: 'mainnet', pad: PAD, size: '1', buyQuoteIn: { wbnb: '0.5' }, dailyBudgetQuote: { wbnb: '10', usdt: '1' } })
    const st = { positions: {}, sniped: {}, daily: { date: 'x', spent: {}, perCreator: {} } }
    expect(planBuy(cfg, ev(98), st, { wallet: 3n * E18 / 10n }).quoteIn).toBe(3n * E18 / 10n)
    expect(planBuy(cfg, ev(98), st, { wallet: 4n * E18 / 100n }).skip).toBe('wallet_below_open_cost')
  })
})
