/** Read-only chain access (viem over HTTP) + calldata builders. Signing never happens here; baw signs. */
import { createPublicClient, http, encodeFunctionData, decodeAbiParameters, getAddress, maxUint256 } from 'viem'
import { bsc, bscTestnet } from 'viem/chains'
import { V3_ABI, ERC20_ABI, WBNB_ABI, ROUTER_ABI, CREATED_TOPIC } from './abi.js'

export function makeClient(net) {
  // 750ms receipt polling (viem default 4s): a fill's refund is back sooner for the next snipe
  return createPublicClient({ chain: net.chainId === 56 ? bsc : bscTestnet, pollingInterval: 750, transport: http(net.rpc, { timeout: 10_000, retryCount: 2 }) })
}

const topicAddr = (t) => getAddress(`0x${t.slice(26)}`)

/**
 * Decode a LaunchpadV3 Created log straight from topics/data (no ABI lookup on the hot path).
 * topics[1]=token, [2]=creator, [3]=quote; data = (name, symbol, logoURI, refPair, gradAmt).
 */
export function parseCreated(l) {
  if (l.topics?.[0]?.toLowerCase() !== CREATED_TOPIC) return null
  const [name, symbol, logoURI, refPair, gradAmt] = decodeAbiParameters(
    [{ type: 'string' }, { type: 'string' }, { type: 'string' }, { type: 'address' }, { type: 'uint256' }], l.data,
  )
  return {
    token: topicAddr(l.topics[1]), creator: topicAddr(l.topics[2]), quote: topicAddr(l.topics[3]),
    name, symbol, logoURI, refPair, gradAmt,
    blockNumber: BigInt(l.blockNumber), txHash: l.transactionHash, logIndex: Number(l.logIndex), removed: !!l.removed,
  }
}

export async function readCurve(client, pad, token) {
  const r = await client.readContract({ address: pad, abi: V3_ABI, functionName: 'curves', args: [token] })
  const [creator, quote, realQuote, sold, gradAmt, virtualQuote, graduated, buyTaxBps, sellTaxBps, dividendBps, pair, refPair] = r
  return { creator, quote, realQuote, sold, gradAmt, virtualQuote, graduated, buyTaxBps: BigInt(buyTaxBps), sellTaxBps: BigInt(sellTaxBps), dividendBps, pair, refPair }
}

export const balanceOf = (client, token, who) => client.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [who] })
export const allowance = (client, token, owner, spender) => client.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [owner, spender] })
export const isAgent = (client, pad, who) => client.readContract({ address: pad, abi: V3_ABI, functionName: 'isAgent', args: [who] })
export const symbolOf = (client, token) => client.readContract({ address: token, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => '?')

export async function poolAmountOut(client, router, amountIn, path) {
  const out = await client.readContract({ address: router, abi: ROUTER_ABI, functionName: 'getAmountsOut', args: [amountIn, path] })
  return out[out.length - 1]
}

export const calldata = {
  buy: (token, quoteIn, minTokensOut) => encodeFunctionData({ abi: V3_ABI, functionName: 'buy', args: [token, quoteIn, minTokensOut] }),
  sell: (token, tokensIn, minQuoteOut) => encodeFunctionData({ abi: V3_ABI, functionName: 'sell', args: [token, tokensIn, minQuoteOut] }),
  approve: (spender, amount = maxUint256) => encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [spender, amount] }),
  wrap: () => encodeFunctionData({ abi: WBNB_ABI, functionName: 'deposit' }),
  poolSell: (amountIn, minOut, path, to, deadline) => encodeFunctionData({
    abi: ROUTER_ABI, functionName: 'swapExactTokensForTokensSupportingFeeOnTransferTokens', args: [amountIn, minOut, path, to, deadline],
  }),
}

/** Historical logs of one event on `address`, decoded by `parse` (backfill after a WSS gap, replay). */
export async function logsFor(client, address, topic, parse, fromBlock, toBlock, chunk = 5000n) {
  const out = []
  // public RPCs cap the getLogs range; walk it in chunks. topic0 is re-checked locally: some RPCs ignore the filter
  for (let b = fromBlock; b <= toBlock; b += chunk) {
    const to = b + chunk - 1n > toBlock ? toBlock : b + chunk - 1n
    const logs = await client.getLogs({ address, fromBlock: b, toBlock: to, topics: [topic] })
    out.push(...logs.filter((l) => l.topics[0]?.toLowerCase() === topic.toLowerCase()).map(parse).filter(Boolean))
  }
  return out
}

/** Historical V3 Created logs (testnet replay). */
export const createdLogs = (client, pad, fromBlock, toBlock, chunk) => logsFor(client, pad, CREATED_TOPIC, parseCreated, fromBlock, toBlock, chunk)
