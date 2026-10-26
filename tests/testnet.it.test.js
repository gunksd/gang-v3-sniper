/**
 * Live BSC testnet checks (TESTNET_IT=1 npm run test:testnet). No orders: baw has no testnet.
 * Uses gang's current testnet deployment (gang-launchpad docs/TESTNET-CORE-ROUTER-2026-10-26.md).
 */
import { describe, it, expect } from 'vitest'
import { decodeAbiParameters, getAddress } from 'viem'

process.env.SNIPER_DATA_DIR = '/tmp/gang-sniper-it'
const { NETWORKS } = await import('../src/config.js')
const { makeClient, createdLogs, readCurve } = await import('../src/chain.js')
const { listenCreated } = await import('../src/listener.js')
const { fingerprint, discoverPad, candidates } = await import('../src/discover.js')
const { parseFairCreated, FAIR_CREATED_TOPIC } = await import('../src/fair.js')
const { freshCurve, simulateBuy } = await import('../src/curve.js')

const run = process.env.TESTNET_IT ? describe : describe.skip
const net = NETWORKS.testnet
const client = makeClient(net)
const V3 = '0x5D5068d11Cc3c768dc0Cc8F460a5593F5b76ce83' // block 139051852
const FAIR = '0x5ef164cc3A812a5892Ed6ab33e7754339dFcA1d7' // block 139051953
const OLD_V3 = '0xFFE9a823FbA62d0a77d4f8bB83965299b5664395' // pre-audit, no router entry
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

run('testnet discovery (gang published addresses → fingerprint)', () => {
  it('the repo broadcast lists both current pads', async () => {
    expect((await candidates(net, 'v3', ['repo'])).map((c) => c.address)).toContain(V3)
    expect((await candidates(net, 'fair', ['repo'])).map((c) => c.address)).toContain(FAIR)
  }, 30_000)

  it('discovers both with no pad configured', async () => {
    const [v3, fair] = await Promise.all([
      discoverPad({ client, net, kind: 'v3' }),
      discoverPad({ client, net, kind: 'fair' }),
    ])
    expect(v3.pad).toBe(V3)
    expect(fair.pad).toBe(FAIR)
  }, 60_000)

  it('rejects the wrong kind, the pre-audit build and the mainnet V2 pad', async () => {
    expect((await fingerprint(client, V3, net, 'fair')).ok).toBe(false)
    expect((await fingerprint(client, FAIR, net, 'v3')).ok).toBe(false)
    expect((await fingerprint(client, OLD_V3, net, 'v3')).reasons).toContain('no routers() (not the audited build)')
    const m = makeClient(NETWORKS.mainnet)
    for (const k of ['v3', 'fair']) expect((await fingerprint(m, '0x1B8F3f69DFa0a7F63d308C7EB0Fd38D8b099966E', NETWORKS.mainnet, k)).ok).toBe(false)
  }, 60_000)
})

run('testnet events', () => {
  it('V3 Created decodes with quote from topics[3]; curves() matches', async () => {
    const evs = await createdLogs(client, V3, 139051852n, 139056852n)
    expect(evs.length).toBeGreaterThan(0)
    const c = await readCurve(client, V3, evs[0].token)
    expect(c.quote).toBe(evs[0].quote)
    if (!c.graduated) {
      const fresh = { ...freshCurve(c.gradAmt, Number(c.buyTaxBps), Number(c.sellTaxBps)), realQuote: c.realQuote, sold: c.sold }
      expect(fresh.virtualQuote).toBe(c.virtualQuote)
      expect(simulateBuy(fresh, 10n ** 16n).tokensOut > 0n).toBe(true)
    }
  }, 30_000)

  it('the 打新 listener backfills the RFT sale from its creation block', async () => {
    const seen = []
    await new Promise((resolve) => {
      const l = listenCreated({
        urls: [net.wss], pad: FAIR, client, fromBlock: 139052070n, topic: FAIR_CREATED_TOPIC, parse: parseFairCreated,
        onCreated: (ev, meta) => seen.push({ symbol: ev.symbol, cap: ev.capShares, backfilled: meta.backfilled }),
      })
      setTimeout(() => { l.stop(); resolve() }, 12_000)
    })
    expect(seen).toContainEqual({ symbol: 'RFT', cap: 100n, backfilled: true })
  }, 30_000)

  it('listenCreated delivers live subscription logs', async () => {
    const got = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { l.stop(); reject(new Error('no live log in 45s')) }, 45_000)
      const l = listenCreated({
        urls: [net.wss], pad: net.wbnb, client, topic: TRANSFER,
        parse: (raw) => ({ token: getAddress(raw.address), txHash: raw.transactionHash, logIndex: Number(raw.logIndex), blockNumber: BigInt(raw.blockNumber), amount: decodeAbiParameters([{ type: 'uint256' }], raw.data)[0] }),
        onCreated: (ev, meta) => { clearTimeout(timer); l.stop(); resolve({ ev, meta }) },
      })
    })
    expect(got.ev.token).toBe(getAddress(net.wbnb))
    expect(got.meta.backfilled).toBe(false)
  }, 60_000)
})
