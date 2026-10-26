/**
 * Auto-discovery of the mainnet LaunchpadV3 address.
 *
 * Trust anchor: the mainnet deploy reuses the live PlatformFeeBucket (owner = the gang team EOA). The pad cannot
 * trade until that owner calls bucket.setOperator(pad, true) — notifyAccrual reverts for non-operators — and only the
 * owner can emit OperatorUpdated. So: every OperatorUpdated(x, true) on the bucket is a candidate, and a candidate is
 * accepted only if it also passes the LaunchpadV3 fingerprint (V3-only constants, wiring back to the same bucket,
 * router / migrator pointing back at it). A look-alike contract deployed by anyone else never gets the operator flag.
 */
import { parseAbi, getAddress, keccak256, toBytes } from 'viem'
import { log } from './log.js'

export const OPERATOR_UPDATED_TOPIC = keccak256(toBytes('OperatorUpdated(address,bool)'))

const PAD_ABI = parseAbi([
  'function PLATFORM_TAX_BPS() view returns (uint256)',
  'function MIN_TAX_BPS() view returns (uint16)',
  'function MAX_TAX_BPS() view returns (uint16)',
  'function TARGET_GRAD_BNB() view returns (uint256)',
  'function MAX_PER_WALLET() view returns (uint256)',
  'function platformBucket() view returns (address)',
  'function recipientRegistry() view returns (address)',
  'function router() view returns (address)',
  'function migrator() view returns (address)',
  'function wbnb() view returns (address)',
  'function agentGateEnabled() view returns (bool)',
  'function walletCapEnabled() view returns (bool)',
  'function owner() view returns (address)',
  'function tokenCount() view returns (uint256)',
])
const BACKREF_ABI = parseAbi(['function launchpad() view returns (address)'])
const BUCKET_ABI = parseAbi(['function operators(address) view returns (bool)', 'function owner() view returns (address)'])

const eq = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()

/** Decode an OperatorUpdated log. Filters locally on topic0: some public RPCs ignore the topics filter. */
export function parseOperatorUpdated(l) {
  if (!eq(l.topics?.[0], OPERATOR_UPDATED_TOPIC) || l.topics.length < 2) return null
  return {
    account: getAddress(`0x${l.topics[1].slice(26)}`),
    enabled: BigInt(l.data || '0x0') !== 0n,
    blockNumber: BigInt(l.blockNumber),
    txHash: l.transactionHash,
    logIndex: Number(l.logIndex),
  }
}

/**
 * LaunchpadV3 fingerprint. → { ok, reasons[], facts }
 * Every check comes from LaunchpadV3.sol constants / constructor wiring or DeployLaunchpadV3.s.sol's _check().
 */
export async function fingerprintV3(client, addr, net) {
  const reasons = []
  const facts = { address: getAddress(addr) }
  const code = await client.getCode({ address: addr }).catch(() => null)
  if (!code || code === '0x') return { ok: false, reasons: ['no contract code'], facts }

  const read = (functionName, address = addr, abi = PAD_ABI) => client.readContract({ address, abi, functionName }).catch(() => undefined)
  const names = ['PLATFORM_TAX_BPS', 'MIN_TAX_BPS', 'MAX_TAX_BPS', 'TARGET_GRAD_BNB', 'MAX_PER_WALLET', 'platformBucket',
    'recipientRegistry', 'router', 'migrator', 'wbnb', 'agentGateEnabled', 'walletCapEnabled', 'owner', 'tokenCount']
  const vals = await Promise.all(names.map((n) => read(n)))
  names.forEach((n, i) => { facts[n] = vals[i] })

  const want = (cond, msg) => { if (!cond) reasons.push(msg) }
  want(facts.PLATFORM_TAX_BPS === 50n, `PLATFORM_TAX_BPS=${facts.PLATFORM_TAX_BPS} (want 50; V2 has no such getter)`)
  want(facts.MIN_TAX_BPS === 100 && facts.MAX_TAX_BPS === 500, `tax bounds ${facts.MIN_TAX_BPS}-${facts.MAX_TAX_BPS} (want 100-500)`)
  want(facts.TARGET_GRAD_BNB === 15n * 10n ** 18n, 'TARGET_GRAD_BNB != 15e18')
  want(facts.MAX_PER_WALLET === 10_000_000n * 10n ** 18n, 'MAX_PER_WALLET != 1% of supply')
  want(eq(facts.platformBucket, net.v3Anchor.bucket), `platformBucket ${facts.platformBucket} != anchor ${net.v3Anchor.bucket}`)
  want(eq(facts.wbnb, net.wbnb), 'wbnb mismatch')
  want(facts.agentGateEnabled === true, 'agent gate off')
  want(facts.walletCapEnabled === true, 'wallet cap off')
  want(!!facts.recipientRegistry && !eq(facts.recipientRegistry, '0x0000000000000000000000000000000000000000'), 'no recipientRegistry')

  if (facts.router) {
    facts.routerLaunchpad = await read('launchpad', facts.router, BACKREF_ABI)
    want(eq(facts.routerLaunchpad, addr), `router.launchpad ${facts.routerLaunchpad} != pad`)
  } else reasons.push('no router')
  if (facts.migrator && !eq(facts.migrator, '0x0000000000000000000000000000000000000000')) {
    facts.migratorLaunchpad = await read('launchpad', facts.migrator, BACKREF_ABI)
    want(eq(facts.migratorLaunchpad, addr), `migrator.launchpad ${facts.migratorLaunchpad} != pad`)
  } else reasons.push('migrator not set (create would revert MigratorNotSet)')

  facts.bucketOperator = await client.readContract({ address: net.v3Anchor.bucket, abi: BUCKET_ABI, functionName: 'operators', args: [addr] })
    .catch(() => undefined)
  want(facts.bucketOperator === true, 'not an operator on the anchor bucket (buys would revert)')

  return { ok: reasons.length === 0, reasons, facts }
}

/** The anchor itself must still be what we trust: right owner, has code. */
export async function checkAnchor(client, net) {
  const owner = await client.readContract({ address: net.v3Anchor.bucket, abi: BUCKET_ABI, functionName: 'owner' }).catch(() => null)
  if (!eq(owner, net.v3Anchor.owner)) return `anchor bucket owner is ${owner}, expected ${net.v3Anchor.owner}`
  return null
}

/** Historical OperatorUpdated(true) accounts on the anchor bucket, newest last. */
export async function operatorEvents(client, net, fromBlock, toBlock, chunk = 50_000n) {
  const out = []
  for (let b = fromBlock; b <= toBlock; b += chunk) {
    const to = b + chunk - 1n > toBlock ? toBlock : b + chunk - 1n
    const logs = await client.getLogs({ address: net.v3Anchor.bucket, fromBlock: b, toBlock: to, topics: [OPERATOR_UPDATED_TOPIC] })
    for (const l of logs) {
      const e = parseOperatorUpdated(l)
      if (e) out.push(e)
    }
  }
  return out
}

/**
 * Scan from `fromBlock`, then follow new blocks (WSS subscription on the bucket + HTTP poll as backup) until a
 * candidate passes the fingerprint. Resolves { pad, facts, event }.
 */
/**
 * Free public RPCs only serve getLogs for recent blocks (publicnode: ~10k ≈ 8h; older = "archive request"), so the
 * history scan never reaches further back than MAX_LOOKBACK from head. Coverage before that comes from the live WSS
 * subscription and from `onCursor`, which lets the caller persist how far it has scanned across restarts.
 */
export const MAX_LOOKBACK = 9_000n
// public RPCs load-balance across nodes a few blocks apart: getLogs up to the head one node reported can be refused
// ("range extends beyond current head") by another. The newest blocks are covered by the WSS subscription anyway.
export const HEAD_MARGIN = 3n

export function discoverPad({ client, net, fromBlock, pollMs = 15_000, signal, chunk = 5_000n, onCursor, maxLookback = 'maxLookback' in net.v3Anchor ? net.v3Anchor.maxLookback : MAX_LOOKBACK }) {
  return new Promise((resolve, reject) => {
    const checked = new Map() // address → last result (re-checked later if it failed for wiring that may still come)
    let cursor = fromBlock ?? null
    let gapLogged = false
    let done = false
    let ws = null
    let timer = null

    const finish = (r) => {
      if (done) return
      done = true
      clearInterval(timer)
      try { ws?.close() } catch { /* */ }
      resolve(r)
    }

    const consider = async (ev) => {
      if (done || !ev.enabled) return
      const key = ev.account.toLowerCase()
      const fp = await fingerprintV3(client, ev.account, net)
      if (done) return // another candidate won while this one was being checked
      checked.set(key, { ev, fp })
      log('v3_candidate', { account: ev.account, block: ev.blockNumber, tx: ev.txHash, ok: fp.ok, reasons: fp.reasons })
      if (fp.ok) finish({ pad: fp.facts.address, facts: fp.facts, event: ev })
    }

    // candidates that failed only because wiring (migrator / router back-ref) lands in a later tx get re-checked
    const recheck = async () => {
      for (const { ev, fp } of checked.values()) {
        if (done) return
        if (fp.ok || fp.reasons.some((r) => /PLATFORM_TAX_BPS|tax bounds|no contract code|platformBucket/.test(r))) continue
        await consider(ev)
      }
    }

    const scan = async () => {
      if (done) return
      try {
        const head = (await client.getBlockNumber()) - HEAD_MARGIN
        const floor = maxLookback == null || head <= maxLookback ? 0n : head - maxLookback
        if (cursor == null || cursor < floor) {
          if (cursor != null && !gapLogged) {
            gapLogged = true
            log('v3_discover_gap', { from: cursor, to: floor - 1n, note: 'older than the public RPC keeps logs for; not scanned (set SNIPER_RPC to an archive node to cover it)' })
          }
          cursor = floor
        }
        if (cursor <= head) {
          for (const ev of await operatorEvents(client, net, cursor, head, chunk)) {
            if (done) return
            await consider(ev)
          }
          cursor = head + 1n
          onCursor?.(cursor)
        }
        await recheck()
      } catch (e) {
        log('v3_discover_error', { error: e.shortMessage || e.message })
      }
    }

    const subscribe = () => {
      if (done) return
      ws = new WebSocket(net.wss.split(',')[0].trim())
      ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['logs', { address: net.v3Anchor.bucket, topics: [OPERATOR_UPDATED_TOPIC] }] }))
      ws.onmessage = (m) => {
        let msg
        try { msg = JSON.parse(String(m.data)) } catch { return }
        if (msg.method !== 'eth_subscription') return
        const ev = parseOperatorUpdated(msg.params.result)
        if (ev) consider(ev).catch((e) => log('v3_discover_error', { error: e.message }))
      }
      ws.onclose = () => { if (!done) setTimeout(subscribe, 3000) }
      ws.onerror = () => { /* onclose reconnects */ }
    }

    signal?.addEventListener('abort', () => { done = true; clearInterval(timer); try { ws?.close() } catch { /* */ }; reject(new Error('discovery aborted')) }, { once: true })
    checkAnchor(client, net).then((err) => {
      if (done) return // aborted while the anchor was being checked
      if (err) { done = true; return reject(new Error(err)) }
      subscribe()
      scan()
      timer = setInterval(scan, pollMs)
    }, reject)
  })
}
