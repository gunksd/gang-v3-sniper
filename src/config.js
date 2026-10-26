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

export const NETWORKS = {
  mainnet: {
    chainId: 56,
    bawChainId: '56',
    // LaunchpadV3 mainnet address is not published yet (2026-10-26: testnet only). Set SNIPER_PAD when it is.
    pad: null,
    wss: 'wss://bsc-rpc.publicnode.com',
    rpc: 'https://bsc-rpc.publicnode.com',
    wbnb: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    usdt: '0x55d398326f99059fF775485246999027B3197955',
    router: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
    // auto-discovery anchor: the live V2 PlatformFeeBucket that DeployLaunchpadV3 reuses on mainnet. Only its owner
    // (gang team EOA, docs/MAINNET-LAUNCHPAD-V2-ADDRESSES-2026-10-23.md) can make a pad an operator.
    v3Anchor: { bucket: '0xBDDd8F275D7Cb65f5454D0bEDf0463792878F111', owner: '0x4EEdcDF5fab775e10C0D09951b6F59Ab81ba19d3' },
  },
  testnet: {
    chainId: 97,
    bawChainId: null, // baw has no BSC testnet: listen + quote only, never execute
    pad: '0xFFE9a823FbA62d0a77d4f8bB83965299b5664395',
    wss: 'wss://bsc-testnet-rpc.publicnode.com',
    rpc: 'https://bsc-testnet-rpc.publicnode.com',
    wbnb: '0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd',
    usdt: null,
    router: '0xD99D1c33F9fC3444f8101754aBC46c52416550D1',
    // testnet stack deployed its own bucket (owner = deployer); used to test discovery against the real V3 pad
    v3Anchor: { bucket: '0xDD649e7F74aD1719b81454D4612fCC062722836b', owner: '0xCa8e63434072B40d3dFE6f5e7Fd885F93A3200b6', fromBlock: 139006483n, maxLookback: null }, // testnet RPC serves old logs
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
  dailyBudgetQuote: { wbnb: '0.5', usdt: '400' }, // actual cost kept by the pad per day (refunds don't count)
  autoWrap: true, // live: keep WBNB ≥ one buy's pull by wrapping native BNB above gasReserveBnb
  gasReserveBnb: '0.01',
  slippagePct: 3, // vs local quote at the event block; wider = more fills when others land first
  skipCreators: [],
  onlyCreators: [], // non-empty = whitelist
  maxPerCreatorPerDay: 2,
  dryRun: true,
  autoDiscover: true, // no pad configured → watch the anchor bucket and fill the V3 address in automatically
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
    size: process.env.SNIPER_SIZE,
    exit: process.env.SNIPER_EXIT,
    dryRun: process.env.SNIPER_DRY_RUN != null ? process.env.SNIPER_DRY_RUN !== '0' : undefined,
    slippagePct: envJson('SNIPER_SLIPPAGE'),
  }
  const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))
  const cfg = { ...DEFAULTS, ...file, ...clean(env), ...clean(overrides) }
  const net = NETWORKS[cfg.network]
  if (!net) throw new Error(`unknown network ${cfg.network} (mainnet | testnet)`)
  const resolved = {
    ...cfg,
    net: {
      ...net,
      pad: cfg.pad || cfg.discovered?.[cfg.network]?.pad || net.pad,
      wss: process.env.SNIPER_WSS || net.wss,
      rpc: process.env.SNIPER_RPC || net.rpc,
    },
  }
  validate(resolved)
  return resolved
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
  if (!cfg.net.pad && !cfg.autoDiscover) {
    throw new Error(`no LaunchpadV3 address for ${cfg.network}: set SNIPER_PAD (or "pad" in ${CONFIG_FILE}), or enable autoDiscover`)
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

/** Persist the discovered pad for this network into ~/.gang-sniper/config.json (keeps every other setting). */
export function savePad(network, pad, meta = {}) {
  mkdirSync(DATA_DIR, { recursive: true })
  const file = existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) : {}
  const discovered = { ...(file.discovered || {}), [network]: { pad, at: new Date().toISOString(), ...meta } }
  writeFileSync(CONFIG_FILE, JSON.stringify({ ...file, discovered }, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n')
}
