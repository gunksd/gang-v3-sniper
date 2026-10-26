/**
 * Binance Agentic Wallet (`baw`) wrapper. Async (execFile) so the event loop keeps serving the WSS while a
 * preview/execute is in flight. baw only reaches www.binance.com through the local proxy when Node is told to
 * use it, so NODE_USE_ENV_PROXY=1 is always set for the child.
 */
import { execFile } from 'node:child_process'

const ENV = { ...process.env, NODE_USE_ENV_PROXY: '1' }

export function baw(args, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('baw', [...args, '--json'], { env: ENV, encoding: 'utf8', maxBuffer: 8 << 20, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err?.code === 'ENOENT') {
        return reject(new Error('找不到 baw（币安 Agentic Wallet CLI）。安装：npm i -g @binance/agentic-wallet，然后 baw auth signin'))
      }
      // baw exits non-zero with a JSON error body on stdout
      try { return resolve(JSON.parse(stdout)) } catch { /* fall through */ }
      reject(new Error(`baw ${args.slice(0, 2).join(' ')} failed: ${(stdout + stderr).trim() || err?.message}`))
    })
  })
}

const unwrap = (r, what) => {
  if (!r.success) throw new Error(`${what}: ${JSON.stringify(r.error)}`)
  return r.data
}

export async function bawAddress(chainId = '56') {
  const r = await baw(['wallet', 'address'])
  if (!r.success && /UNCONNECTED|NOT_LOGGED_IN|not logged in|not.*sign/i.test(JSON.stringify(r.error))) {
    throw new Error(`baw 未登录：先运行 baw auth signin（${JSON.stringify(r.error)}）`)
  }
  const d = unwrap(r, 'wallet address')
  const a = d.addresses.find((x) => x.binanceChainId === chainId)
  if (!a) throw new Error(`Agentic Wallet has no address on chain ${chainId}`)
  return a.address
}

export async function bawStatus() {
  const r = await baw(['wallet', 'status'])
  return r.success ? r.data.status : 'UNCONNECTED'
}

export async function bawSettings() {
  return unwrap(await baw(['wallet', 'settings']), 'wallet settings')
}

/**
 * Preview through Binance's risk engine. Returns { requestId, requireConfirmation, simulationOk, simulation, risks }.
 * A failed simulation is returned (not thrown) so the caller can log why a snipe was skipped.
 */
export async function bawPreview({ from, to, data, value = 0n, chainId = '56', gasLimit }) {
  const args = ['contract-call', 'preview', '--binanceChainId', chainId, '--from', from, '--to', to,
    '--value', value.toString(), '--inputData', data]
  if (gasLimit) args.push('--gasLimit', String(gasLimit))
  const r = await baw(args)
  if (!r.success) return { ok: false, error: r.error }
  const d = r.data
  const sim = d.simulationResult || {}
  return {
    ok: true,
    requestId: d.requestId,
    expiresAt: d.expiresAt,
    requireConfirmation: !!d.requireConfirmation,
    simulationOk: !sim.simulationErrorDetail && (sim.simulationCode == null || /^0+$/.test(sim.simulationCode)),
    simulationError: sim.simulationErrorDetail || null,
    balanceChanges: sim.balanceChanges || [],
    risks: d.risks?.riskDetails || [],
  }
}

/** Execute a previewed call. → { status, txHash, orderId, pending } */
export async function bawExecute(requestId) {
  const r = await baw(['contract-call', 'execute', '--requestId', requestId], { timeoutMs: 60_000 })
  if (!r.success) return { ok: false, error: r.error }
  const d = r.data
  return { ok: true, status: d.status, txHash: d.txHash || null, orderId: d.orderId || null, pending: d.status === 'PENDING_CONFIRMATION' }
}

/** preview → execute in one go; refuses calls that would need App confirmation (a snipe can't wait for a human). */
export async function bawSend(call, { allowConfirmation = false } = {}) {
  const p = await bawPreview(call)
  if (!p.ok) return { ok: false, stage: 'preview', error: p.error }
  if (!p.simulationOk) return { ok: false, stage: 'simulation', error: p.simulationError, preview: p }
  if (p.requireConfirmation && !allowConfirmation) return { ok: false, stage: 'confirmation', error: 'risk engine requires App confirmation', preview: p }
  const e = await bawExecute(p.requestId)
  return { ...e, stage: 'execute', preview: p }
}
