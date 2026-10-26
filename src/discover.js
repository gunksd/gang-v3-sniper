/**
 * Auto-discovery of the LaunchpadV3 and 打新 (FairMintPad) addresses.
 *
 * The mainnet runbook (gang-launchpad docs/MAINNET-RUNBOOK-V3-FAIR-2026-10-26.md) deploys both pads from a fresh hot
 * wallet onto a NEW shared QuoteRegistry + PlatformFeeBucket, then hands them to a multisig. Nothing on-chain ties the
 * new contracts to a known address before that, so the trust anchor is gang's own publishing, checked on-chain:
 *
 *   sources (any one is enough)              then every candidate must pass the pad's fingerprint
 *   - gang.fun /api/v3/config, /fair/config  - the pad's constants (V3 tax bounds / fair 10,000 shares, caps)
 *   - repo broadcast/<script>/<chain>/…json  - wired to the real Agent ID registry and WBNB
 *   - npm @gangfun/cli src/v3.js, fair.js    - migrator and fee bucket pointing back at it, bucket burning into GANG
 *
 * A look-alike contract deployed by anyone else is never published by those sources; one published by mistake that
 * isn't a real pad fails the fingerprint.
 */
import { parseAbi, getAddress, isAddress } from 'viem'
import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { log } from './log.js'
import { redact } from './config.js'

const ZERO = '0x0000000000000000000000000000000000000000'
const eq = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
const E18 = 10n ** 18n

const COMMON_ABI = parseAbi([
  'function wbnb() view returns (address)',
  'function agentGateEnabled() view returns (bool)',
  'function agentIdRegistry() view returns (address)',
  'function migrator() view returns (address)',
  'function platformBucket() view returns (address)',
  'function owner() view returns (address)',
  'function pendingOwner() view returns (address)',
  'function tokenCount() view returns (uint256)',
])
const V3_ABI = parseAbi([
  'function PLATFORM_TAX_BPS() view returns (uint256)',
  'function MIN_TAX_BPS() view returns (uint16)',
  'function MAX_TAX_BPS() view returns (uint16)',
  'function TARGET_GRAD_BNB() view returns (uint256)',
  'function MAX_PER_WALLET() view returns (uint256)',
  'function walletCapEnabled() view returns (bool)',
  'function router() view returns (address)',
  'function recipientRegistry() view returns (address)',
])
const FAIR_ABI = parseAbi([
  'function TOTAL_SHARES() view returns (uint256)',
  'function TOKENS_PER_SHARE() view returns (uint256)',
  'function MIN_CAP_BPS() view returns (uint16)',
  'function MAX_CAP_BPS() view returns (uint16)',
  'function MIN_RAISE_BNB() view returns (uint256)',
  'function MAX_RAISE_BNB() view returns (uint256)',
  'function taxHandler() view returns (address)',
])
const BACKREF_ABI = parseAbi(['function launchpad() view returns (address)'])
// GangRouter entry (audited build, gang-launchpad 47a063b): both pads expose it; pre-audit test deployments don't
const ROUTERS_ABI = parseAbi(['function routers(address) view returns (bool)'])
const BUCKET_ABI = parseAbi(['function operators(address) view returns (bool)', 'function burner() view returns (address)'])

/** kind → what the pad must look like. Values from LaunchpadV3.sol / FairMintPad.sol on gang-launchpad main. */
const KINDS = {
  v3: {
    abi: V3_ABI,
    want: {
      PLATFORM_TAX_BPS: 50n, MIN_TAX_BPS: 100, MAX_TAX_BPS: 500, TARGET_GRAD_BNB: 15n * E18,
      MAX_PER_WALLET: 10_000_000n * E18, walletCapEnabled: true,
    },
  },
  fair: {
    abi: FAIR_ABI,
    want: {
      TOTAL_SHARES: 10_000n, TOKENS_PER_SHARE: 50_000n * E18, MIN_CAP_BPS: 10, MAX_CAP_BPS: 50,
      MIN_RAISE_BNB: 5n * E18, MAX_RAISE_BNB: 50n * E18,
    },
  },
}

/** Fingerprint a candidate as `kind` ('v3' | 'fair'). → { ok, reasons[], facts } */
export async function fingerprint(client, addr, net, kind) {
  const spec = KINDS[kind]
  const reasons = []
  const facts = { address: getAddress(addr), kind }
  const code = await client.getCode({ address: addr }).catch(() => null)
  if (!code || code === '0x') return { ok: false, reasons: ['no contract code'], facts }

  const read = (abi, name, address = addr, args) => client.readContract({ address, abi, functionName: name, args }).catch(() => undefined)
  const common = ['wbnb', 'agentGateEnabled', 'agentIdRegistry', 'migrator', 'platformBucket', 'owner', 'pendingOwner', 'tokenCount']
  const own = Object.keys(spec.want).concat(kind === 'v3' ? ['router', 'recipientRegistry'] : ['taxHandler'])
  const [cv, ov] = await Promise.all([
    Promise.all(common.map((n) => read(COMMON_ABI, n))),
    Promise.all(own.map((n) => read(spec.abi, n))),
  ])
  common.forEach((n, i) => { facts[n] = cv[i] })
  own.forEach((n, i) => { facts[n] = ov[i] })

  const want = (cond, msg) => { if (!cond) reasons.push(msg) }
  for (const [k, v] of Object.entries(spec.want)) want(facts[k] === v, `${k}=${facts[k]} (want ${v})`)
  want(eq(facts.wbnb, net.wbnb), 'wbnb mismatch')
  want(facts.agentGateEnabled === true, 'agent gate off')
  want(eq(facts.agentIdRegistry, net.agentIdRegistry), `agentIdRegistry ${facts.agentIdRegistry} != ${net.agentIdRegistry}`)
  want((await read(ROUTERS_ABI, 'routers', addr, [ZERO])) === false, 'no routers() (not the audited build)')

  // the pad only opens once setMigrator ran (last step of the deploy): before that, create reverts
  if (facts.migrator && !eq(facts.migrator, ZERO)) {
    want(eq(await read(BACKREF_ABI, 'launchpad', facts.migrator), addr), 'migrator.launchpad != pad')
  } else reasons.push('migrator not set yet (pad not open)')
  if (kind === 'v3') {
    if (facts.router) want(eq(await read(BACKREF_ABI, 'launchpad', facts.router), addr), 'router.launchpad != pad')
    else reasons.push('no router')
  }
  if (facts.platformBucket) {
    want((await read(BUCKET_ABI, 'operators', facts.platformBucket, [addr])) === true, 'not an operator on its own fee bucket')
    if (net.gangBurner) {
      facts.burner = await read(BUCKET_ABI, 'burner', facts.platformBucket)
      want(eq(facts.burner, net.gangBurner), `fee bucket burner ${facts.burner} != gang buyback ${net.gangBurner}`)
    }
  } else reasons.push('no platformBucket')

  return { ok: reasons.length === 0, reasons, facts }
}

// ------------------------------------------------------------------ sources
const addrs = (text) => [...new Set((String(text).match(/0x[0-9a-fA-F]{40}/g) || []).filter((a) => isAddress(a) && !eq(a, ZERO)))]

async function getText(url, timeoutMs = 10_000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'gang-v3-sniper', 'cache-control': 'no-cache' } })
  if (r.status === 404) return null
  if (!r.ok) throw new Error(`${r.status} ${url}`)
  return r.text()
}

/** gang.fun indexer config: `{ enabled: true, … pad address … }` once the server is switched on (runbook §4). */
async function fromSite(net, kind) {
  const t = await getText(`${net.sources.site}/${kind}/config`)
  if (!t) return []
  let j
  try { j = JSON.parse(t) } catch { return [] }
  return j?.enabled ? addrs(t) : []
}

/** Foundry broadcast committed to the repo after the deploy (runbook §1). */
async function fromRepo(net, kind) {
  const script = kind === 'v3' ? 'DeployLaunchpadV3.s.sol' : 'DeployFairMint.s.sol'
  const want = kind === 'v3' ? 'LaunchpadV3' : 'FairMintPad'
  const t = await getText(`${net.sources.repoRaw}/broadcast/${script}/${net.chainId}/run-latest.json`)
  if (!t) return []
  const j = JSON.parse(t)
  return (j.transactions || []).filter((x) => x.contractName === want && x.contractAddress).map((x) => getAddress(x.contractAddress))
}

let npmSeen = null
let npmCache = { v3: [], fair: [] }
/** The CLI release carrying the mainnet pad (runbook §6): src/v3.js / src/fair.js `pad: process.env.GANG_*_PAD || '0x…'`. */
async function fromNpm(net, kind) {
  const meta = JSON.parse(await getText(`https://registry.npmjs.org/${net.sources.npmPackage}/latest`))
  const key = `${meta.version}:${net.chainId}`
  if (key !== npmSeen) {
    const r = await fetch(meta.dist.tarball, { signal: AbortSignal.timeout(20_000) })
    const dir = mkdtempSync(join(tmpdir(), 'gangcli-'))
    try {
      const tgz = join(dir, 'p.tgz')
      writeFileSync(tgz, Buffer.from(await r.arrayBuffer()))
      const read = (f) => new Promise((res) => execFile('tar', ['-xzOf', tgz, `package/src/${f}`], { encoding: 'utf8', maxBuffer: 4 << 20 }, (e, out) => res(e ? '' : out)))
      const block = (src, name) => (src.match(new RegExp(`\\b${name}:\\s*\\{([\\s\\S]*?)\\n\\s*\\},?`)) || [])[1] || ''
      const padIn = (src, envVar) => {
        const b = block(src, net.chainId === 56 ? 'mainnet' : 'testnet')
        const m = b.match(new RegExp(`pad:\\s*process\\.env\\.${envVar}\\s*\\|\\|\\s*'(0x[0-9a-fA-F]{40})'`))
        return m ? [getAddress(m[1])] : []
      }
      const [v3src, fairSrc] = await Promise.all([read('v3.js'), read('fair.js')])
      const sfx = net.chainId === 56 ? '' : '_TESTNET'
      npmCache = { v3: padIn(v3src, `GANG_V3${sfx}_PAD`), fair: padIn(fairSrc, `GANG_FAIR${sfx}_PAD`) }
      npmSeen = key
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  return npmCache[kind]
}

export const SOURCES = { site: fromSite, repo: fromRepo, npm: fromNpm }

/** One pass over every source for `kind`. → [{ address, source }] (deduped, first source wins) */
export async function candidates(net, kind, which = Object.keys(SOURCES)) {
  const out = new Map()
  await Promise.all(which.map(async (name) => {
    try {
      for (const a of await SOURCES[name](net, kind)) if (!out.has(a.toLowerCase())) out.set(a.toLowerCase(), { address: a, source: name })
    } catch (e) {
      log('discover_source_error', { kind, source: name, error: redact(e.message) })
    }
  }))
  return [...out.values()]
}

/**
 * Poll the sources until a candidate passes the fingerprint for `kind`. Resolves { pad, source, facts }.
 * Candidates that failed only on wiring (migrator not set yet, …) are re-checked: the pad opens at the deploy's last tx.
 */
export function discoverPad({ client, net, kind, pollMs = 10_000, signal, sources }) {
  return new Promise((resolve, reject) => {
    let done = false
    let timer = null
    let busy = false
    const seen = new Map() // address → reasons, to log each new outcome once
    const finish = (r) => { done = true; clearInterval(timer); resolve(r) }

    const pass = async () => {
      if (done || busy) return
      busy = true
      try {
        for (const c of await candidates(net, kind, sources)) {
          if (done) return
          const fp = await fingerprint(client, c.address, net, kind)
          const key = c.address.toLowerCase()
          const sig = fp.reasons.join('|')
          if (seen.get(key) !== sig) {
            seen.set(key, sig)
            log('discover_candidate', { kind, address: c.address, source: c.source, ok: fp.ok, reasons: fp.reasons })
          }
          if (fp.ok) return finish({ pad: fp.facts.address, source: c.source, facts: fp.facts })
        }
      } finally {
        busy = false
      }
    }

    signal?.addEventListener('abort', () => { done = true; clearInterval(timer); reject(new Error('discovery aborted')) }, { once: true })
    pass().catch((e) => log('discover_error', { kind, error: redact(e.message) }))
    timer = setInterval(() => pass().catch((e) => log('discover_error', { kind, error: redact(e.message) })), pollMs)
  })
}
