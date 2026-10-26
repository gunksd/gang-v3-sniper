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

  it('two launches back to back with 0.7 WBNB: first sends 0.5, second is skipped until the refund lands', async () => {
    const cfg = loadConfig({ network: 'mainnet', pad: PAD, dryRun: false, size: '1', buyQuoteIn: { wbnb: '0.5' }, dailyBudgetQuote: { wbnb: '1', usdt: '1' }, autoWrap: false, autoPrepare: false })
    const s = new Sniper({ cfg, client, me: '0x' + '9'.repeat(40) })
    s.funds.set(WBNB.toLowerCase(), { balance: 7n * E18 / 10n, allowance: 10n * E18 })
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
