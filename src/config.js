/**
 * Runtime config. Sizes and exit rules are user-selectable presets; everything can be overridden by env or
 * ~/.gang-sniper/config.json (written by `gang-sniper config`).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'

// per-user state (config, positions, log); never inside the package dir, which is read-only / shared when installed globally
export const DATA_DIR = resolve(process.env.SNIPER_DATA_DIR || join(homedir(), '.gang-sniper'))
export const CONFIG_FILE = resolve(DATA_DIR, 'config.json')

const GANG_SOURCES = {
  site: 'https://gang.fun/api',
  repoRaw: 'https://raw.githubusercontent.com/gangfun/gang-launchpad/main',
  npmPackage: '@gangfun/cli',
}

export const NETWORKS = {
  mainnet: {
    chainId: 56,
    bawChainId: '56',
    // pads are found by discovery (src/discover.js) or set by hand: SNIPER_PAD (V3) / SNIPER_FAIR_PAD (打新)
    pad: null,
    fairPad: null,
    wss: 'wss://bsc-rpc.publicnode.com',
    rpc: 'https://bsc-rpc.publicnode.com',
    wbnb: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    usdt: '0x55d398326f99059fF775485246999027B3197955',
    router: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
    // Agent ID NFT both pads gate on (LaunchpadV3MainnetRefs / FairMintDeployRefs AGENT_ID_REGISTRY)
    agentIdRegistry: '0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F',
    // GangBuybackBurner (owner = gang team 0x4EEd…): the new shared fee bucket copies it from the V2 bucket (runbook §0)
    gangBurner: '0x38120bf40F8F19E6cc60622Bc7C5B005dfe5363B',
    sources: GANG_SOURCES,
  },
  testnet: {
    chainId: 97,
    bawChainId: null, // baw has no BSC testnet: listen + quote only, never execute
    pad: null,
    fairPad: null,
    wss: 'wss://bsc-testnet-rpc.publicnode.com',
    rpc: 'https://bsc-testnet-rpc.publicnode.com',
    wbnb: '0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd',
    usdt: null,
    router: '0xD99D1c33F9fC3444f8101754aBC46c52416550D1',
    agentIdRegistry: '0x24D0A2106AC3Ebf7d770d19f4aF0a5149ebe5B2a', // TestnetAgentId
    gangBurner: null, // testnet bucket has no buyback
    sources: GANG_SOURCES,
  },
}

/** Share of total supply to buy. 100 bps = 1% = the per-wallet cap. */
export const SIZE_PRESETS = { '0.25': 25, '0.5': 50, '0.75': 75, '1.0': 100 }
/** `1` and `1.0` both mean the 1% cap. */
const sizeKey = (s) => (String(s) === '1' ? '1.0' : String(s))

/**
 * Exit rules. Each one is evaluated against live curve / pool state for every open position.
 * - multiple: sell everything once value (after exit fees) reaches `takeProfitX` × cost
 * - ladder: sell `steps[i].pct` of the original size at each `steps[i].x`
 * - graduate: hold to graduation, then sell on Pancake (pool sells pay only the sell tax)
 * - progress: sell when curve progress reaches `progressPct` (before graduation, on the curve)
 * Every rule also carries `stopLossPct` (value drop vs cost) and `maxHoldMin` (time stop), 0 = off.
 */
export const EXIT_PRESETS = {
  'x2': { kind: 'multiple', takeProfitX: 2, stopLossPct: 50, maxHoldMin: 360 },
  'x3': { kind: 'multiple', takeProfitX: 3, stopLossPct: 50, maxHoldMin: 360 },
  'ladder': { kind: 'ladder', steps: [{ x: 2, pct: 50 }, { x: 4, pct: 25 }, { x: 8, pct: 25 }], stopLossPct: 50, maxHoldMin: 720 },
  'progress50': { kind: 'progress', progressPct: 50, stopLossPct: 50, maxHoldMin: 360 },
  'graduate': { kind: 'graduate', stopLossPct: 0, maxHoldMin: 1440 },
  'manual': { kind: 'manual', stopLossPct: 0, maxHoldMin: 0 },
}

export const DEFAULTS = {
  network: 'mainnet',
  pad: null,
  size: '1', // SIZE_PRESETS key
  exit: 'x2', // EXIT_PRESETS key
  exitOverrides: {}, // e.g. { takeProfitX: 2.5, stopLossPct: 40 }
  quotes: ['wbnb'], // which quote tokens to snipe: wbnb | usdt | <address>
  maxBuyTaxBps: 300,
  maxSellTaxBps: 300,
  maxSpendQuote: { wbnb: '0.06', usdt: '50' }, // hard per-snipe cap in quote units (1% at open ≈ 0.049 WBNB)
  // fixed amount sent per buy (size must be 1%): the pad keeps the 1% cost, refunds the rest; null = size from preset
  buyQuoteIn: {},
  sequential: false, // one buy at a time: the next waits for the previous receipt (its refund) instead of being skipped
  maxTokens: null, // stop after this many V3 buys in total (null = no limit; counted across restarts)
  dailyBudgetQuote: { wbnb: '0.5', usdt: '400' }, // actual cost kept by the pad per day (refunds don't count)
  autoWrap: true, // live: keep WBNB ≥ one buy's pull by wrapping native BNB above gasReserveBnb
  gasReserveBnb: '0.01',
  slippagePct: 3, // vs local quote at the event block; wider = more fills when others land first
  skipCreators: [],
  onlyCreators: [], // non-empty = whitelist
  maxPerCreatorPerDay: 2,
  dryRun: true,
  // which baw binary signs: 'baw' = this machine's default wallet; a per-wallet wrapper such as ~/.baw2-cli/bin/baw
  // (sets BINANCE_BAW_DIR) selects another one. SNIPER_BAW overrides.
  bawBin: 'baw',
  autoDiscover: true, // no pad configured → find the V3 / 打新 pads from gang's published addresses (src/discover.js)
  // 打新 (fair mint): every sale has one price, so speed only matters for getting in before it fills
  fair: {
    enabled: true,
    maxSales: 1, // how many sales to auto-mint in total (0 = off); counted across restarts
    shares: 'cap', // 'cap' = the per-wallet maximum the sale allows, or a number of shares
    maxSpend: { wbnb: '0.6' }, // principal + mint fee per sale, quote units
    maxMintFeeBps: 500, // skip sales whose mint fee is above this (creator picks 1%–5%)
    sellPctOnLaunch: 50, // sell this share of the minted tokens right after the sale launches
    keepReward: true, // never sell below the sale's hold line: below it the holder reward is lost for good
    sellSlippagePct: 5,
    autoRefund: true, // deadline passed without a fill → claim principal + fee back
  },
  autoPrepare: true, // after discovery (live mode only): approve the pad for dailyBudgetQuote, not unlimited
  pollExitSec: 5,
  reconnectMs: 1500,
}

const envJson = (name) => {
  const v = process.env[name]
  if (v == null || v === '') return undefined
  try { return JSON.parse(v) } catch { return v }
}

export function loadConfig(overrides = {}) {
  const file = existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) : {}
  const env = {
    network: process.env.SNIPER_NETWORK,
    autoDiscover: process.env.SNIPER_AUTO_DISCOVER != null ? process.env.SNIPER_AUTO_DISCOVER !== '0' : undefined,
    pad: process.env.SNIPER_PAD,
    fairPad: process.env.SNIPER_FAIR_PAD,
    size: process.env.SNIPER_SIZE,
    exit: process.env.SNIPER_EXIT,
    bawBin: process.env.SNIPER_BAW,
    dryRun: process.env.SNIPER_DRY_RUN != null ? process.env.SNIPER_DRY_RUN !== '0' : undefined,
    slippagePct: envJson('SNIPER_SLIPPAGE'),
  }
  const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))
  const merged = { ...DEFAULTS, ...file, ...clean(env), ...clean(overrides) }
  const cfg = { ...merged, fair: { ...DEFAULTS.fair, ...(file.fair || {}), ...(overrides.fair || {}) } }
  const net = NETWORKS[cfg.network]
  if (!net) throw new Error(`unknown network ${cfg.network} (mainnet | testnet)`)
  const secret = cfg.network === 'mainnet' ? loadSecrets() : {}
  const secretWss = secret.wss ? [].concat(secret.wss) : (secret.rpc ? [secret.rpc.replace(/^http/, 'ws')] : [])
  // private node first (it serves archive logs), the public one stays subscribed too as a second, independent feed
  const wss = process.env.SNIPER_WSS || [...secretWss, net.wss].join(',')
  const rpc = process.env.SNIPER_RPC || secret.rpc || net.rpc
  const resolved = {
    ...cfg,
    net: {
      ...net,
      pad: cfg.pad || cfg.discovered?.[cfg.network]?.v3?.pad || net.pad,
      fairPad: cfg.fairPad || cfg.discovered?.[cfg.network]?.fair?.pad || net.fairPad,
      wss,
      rpc,
    },
  }
  validate(resolved)
  return resolved
}

/**
 * Private endpoints (API keys) live outside the repo and the shareable config: ~/.config/gang-sniper/secrets.json
 *   { "rpc": "https://…", "wss": ["wss://…"] }    wss defaults to the rpc URL with https→wss
 */
export const SECRETS_FILE = process.env.SNIPER_SECRETS || join(homedir(), '.config', 'gang-sniper', 'secrets.json')
function loadSecrets() {
  if (!existsSync(SECRETS_FILE)) return {}
  try { return JSON.parse(readFileSync(SECRETS_FILE, 'utf8')) } catch (e) { throw new Error(`${SECRETS_FILE}: ${e.message}`) }
}

/** Hide API keys in anything printed or logged: path segments that look like keys, and key-ish query params. */
export function redact(url) {
  return String(url)
    .replace(/(\/v[0-9]+\/)[^/?#\s]{8,}/g, '$1***')
    .replace(/([?&](?:key|apikey|api_key|token)=)[^&#\s]+/gi, '$1***')
}

export function sizeBps(cfg) {
  const bps = SIZE_PRESETS[sizeKey(cfg.size)]
  if (!bps) throw new Error(`size must be one of ${Object.keys(SIZE_PRESETS).join(', ')} (% of supply)`)
  return bps
}

export function exitRule(cfg) {
  const base = EXIT_PRESETS[cfg.exit]
  if (!base) throw new Error(`exit must be one of ${Object.keys(EXIT_PRESETS).join(', ')}`)
  return { name: cfg.exit, ...base, ...cfg.exitOverrides }
}

function validate(cfg) {
  sizeBps(cfg)
  const rule = exitRule(cfg)
  if (rule.kind === 'ladder') {
    const total = rule.steps.reduce((a, s) => a + s.pct, 0)
    if (total !== 100) throw new Error(`ladder steps must add up to 100% (got ${total})`)
  }
  if (!(cfg.slippagePct >= 0 && cfg.slippagePct <= 50)) throw new Error('slippagePct must be 0–50')
  if (Object.keys(cfg.buyQuoteIn || {}).length && sizeBps(cfg) !== 100) {
    // below the cap the pad does not refund: the whole amount would buy tokens, overshooting the chosen size
    throw new Error('buyQuoteIn (fixed send + refund) only works with size 1 (the 1% wallet cap)')
  }
  if (!cfg.net.pad && !cfg.net.fairPad && !cfg.autoDiscover) {
    throw new Error(`no pad for ${cfg.network}: set SNIPER_PAD / SNIPER_FAIR_PAD (or "pad" / "fairPad" in ${CONFIG_FILE}), or enable autoDiscover`)
  }
  const f = cfg.fair
  if (f.enabled) {
    if (!(f.sellPctOnLaunch >= 0 && f.sellPctOnLaunch <= 100)) throw new Error('fair.sellPctOnLaunch must be 0–100')
    if (!(f.sellSlippagePct >= 0 && f.sellSlippagePct <= 50)) throw new Error('fair.sellSlippagePct must be 0–50')
    if (!(Number.isInteger(f.maxSales) && f.maxSales >= 0)) throw new Error('fair.maxSales must be a whole number ≥ 0')
  }
}

/** Map a configured quote entry (wbnb | usdt | 0x…) to a lowercase address for this network. */
export function quoteAddresses(cfg) {
  return cfg.quotes.map((q) => {
    const a = q.startsWith('0x') ? q : cfg.net[q.toLowerCase()]
    if (!a) throw new Error(`quote ${q} has no address on ${cfg.network}`)
    return a.toLowerCase()
  })
}

/** Quote key used in maxSpendQuote / dailyBudgetQuote for an address. */
export function quoteKey(cfg, addr) {
  const a = addr.toLowerCase()
  if (cfg.net.wbnb?.toLowerCase() === a) return 'wbnb'
  if (cfg.net.usdt?.toLowerCase() === a) return 'usdt'
  return a
}

/** Persist a discovered pad (`kind` = 'v3' | 'fair') for this network into config.json (keeps every other setting). */
export function savePad(network, kind, pad, meta = {}) {
  mkdirSync(DATA_DIR, { recursive: true })
  const file = existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) : {}
  const prev = file.discovered?.[network] || {}
  const discovered = { ...(file.discovered || {}), [network]: { ...prev, [kind]: { pad, at: new Date().toISOString(), ...meta } } }
  writeFileSync(CONFIG_FILE, JSON.stringify({ ...file, discovered }, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n')
}
