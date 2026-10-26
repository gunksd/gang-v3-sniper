/**
 * Live BSC testnet checks (TESTNET_IT=1 npm run test:testnet). No orders: baw has no testnet.
 * - the real LaunchpadV3 Created logs decode and plan correctly
 * - listenCreated delivers live subscription messages (proved on a busy topic, WBNB Transfer, since nobody creates
 *   V3 tokens on demand) and backfills a gap from getLogs
 */
import { describe, it, expect } from 'vitest'
import { decodeAbiParameters, getAddress } from 'viem'

process.env.SNIPER_DATA_DIR = '/tmp/gang-sniper-it'
const { NETWORKS } = await import('../src/config.js')
const { makeClient, createdLogs, readCurve } = await import('../src/chain.js')
const { listenCreated } = await import('../src/listener.js')
const { freshCurve, simulateBuy } = await import('../src/curve.js')

const run = process.env.TESTNET_IT ? describe : describe.skip
const net = NETWORKS.testnet
const client = makeClient(net)
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

run('testnet LaunchpadV3', () => {
  it('reads the 3 historical Created events with quote from topics[3]', async () => {
    const evs = await createdLogs(client, net.pad, 139006483n, 139020000n)
    expect(evs.map((e) => e.symbol)).toEqual(['V3T', 'V3O', 'CV3'])
    expect(evs[1].quote).toBe('0x67203AB0B5eC75296b988f289ACCe11DDab19399')
    const c = await readCurve(client, net.pad, evs[2].token)
    expect(c.quote).toBe(evs[2].quote)
    expect(c.buyTaxBps).toBe(200n)
    expect(c.sellTaxBps).toBe(300n)
  }, 30_000)

  it('local curve quote equals the chain for a live (ungraduated) token', async () => {
    const [cv3] = (await createdLogs(client, net.pad, 139018681n, 139018681n))
    const c = await readCurve(client, net.pad, cv3.token)
    if (c.graduated) return
    const fresh = { ...freshCurve(c.gradAmt, Number(c.buyTaxBps), Number(c.sellTaxBps)), realQuote: c.realQuote, sold: c.sold }
    expect(fresh.virtualQuote).toBe(c.virtualQuote)
    const s = simulateBuy(fresh, 10n ** 16n, 0n)
    expect(s.tokensOut > 0n).toBe(true)
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

  it('backfill after a gap replays Created from getLogs, flagged as backfilled', async () => {
    const seen = []
    await new Promise((resolve) => {
      const l = listenCreated({
        urls: [net.wss], pad: net.pad, client, fromBlock: 139018681n, // pretend we started right at the CV3 create
        onCreated: (ev, meta) => seen.push({ symbol: ev.symbol, backfilled: meta.backfilled }),
      })
      setTimeout(() => { l.stop(); resolve() }, 20_000)
    })
    expect(seen).toContainEqual({ symbol: 'CV3', backfilled: true })
  }, 40_000)
})

run('testnet V3 auto-discovery', async () => {
  const { discoverPad, fingerprintV3, operatorEvents } = await import('../src/discover.js')
  const blank = { ...net, pad: null }

  it('finds the real LaunchpadV3 from bucket OperatorUpdated + fingerprint, with pad unset', async () => {
    const found = await discoverPad({ client, net: blank, fromBlock: net.v3Anchor.fromBlock })
    expect(found.pad).toBe(getAddress(net.pad))
    expect(found.event.enabled).toBe(true)
    expect(found.facts.bucketOperator).toBe(true)
  }, 60_000)

  it('only OperatorUpdated counts (OwnershipTransferred in the same range is ignored); the router operator is rejected', async () => {
    const all = await client.getLogs({ address: net.v3Anchor.bucket, fromBlock: 139006483n, toBlock: 139006600n })
    expect(all.length).toBe(4) // 2 × Ownership*, then setOperator(pad), setOperator(router)
    const evs = await operatorEvents(client, net, 139006483n, 139006600n)
    expect(evs.map((e) => e.account)).toEqual([getAddress(net.pad), '0x6a4a00119e7B3334a2681EE26302be6a0Ae5e5F6'])
    // the TaxRouterV3 also becomes an operator: it must fail the pad fingerprint on V3-only getters
    const fr = await fingerprintV3(client, evs[1].account, net)
    expect(fr.ok).toBe(false)
    expect(fr.reasons.join(' ')).toMatch(/PLATFORM_TAX_BPS/)
    // and an EOA operator has no code
    expect((await fingerprintV3(client, '0xCa8e63434072B40d3dFE6f5e7Fd885F93A3200b6', net)).reasons).toEqual(['no contract code'])
  }, 60_000)

  it('mainnet V2 pad fails the V3 fingerprint', async () => {
    const { NETWORKS: N } = await import('../src/config.js')
    const m = makeClient(N.mainnet)
    const fp = await fingerprintV3(m, '0x1B8F3f69DFa0a7F63d308C7EB0Fd38D8b099966E', N.mainnet)
    expect(fp.ok).toBe(false)
    expect(fp.reasons.join(' ')).toMatch(/PLATFORM_TAX_BPS/)
  }, 30_000)

  it('mainnet anchor bucket is owned by the gang team EOA', async () => {
    const { NETWORKS: N } = await import('../src/config.js')
    const { checkAnchor } = await import('../src/discover.js')
    expect(await checkAnchor(makeClient(N.mainnet), N.mainnet)).toBe(null)
  }, 30_000)
})
