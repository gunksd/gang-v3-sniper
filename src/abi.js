/** LaunchpadV3 surface used by the sniper (feat/v3-tax-recipient, src/launchpad-v3/LaunchpadV3.sol). */
import { keccak256, toBytes } from 'viem'

export const CREATED_SIG = 'Created(address,address,string,string,string,address,address,uint256)'
/** topic0 of LaunchpadV3.Created; topics[1]=token, [2]=creator, [3]=quote (all indexed). */
export const CREATED_TOPIC = keccak256(toBytes(CREATED_SIG))

export const V3_ABI = [
  { type: 'event', name: 'Created', inputs: [
    { name: 'token', type: 'address', indexed: true }, { name: 'creator', type: 'address', indexed: true },
    { name: 'name', type: 'string', indexed: false }, { name: 'symbol', type: 'string', indexed: false },
    { name: 'logoURI', type: 'string', indexed: false }, { name: 'quote', type: 'address', indexed: true },
    { name: 'refPair', type: 'address', indexed: false }, { name: 'gradAmt', type: 'uint256', indexed: false },
  ] },
  { type: 'event', name: 'TaxConfigured', inputs: [
    { name: 'token', type: 'address', indexed: true }, { name: 'buyTaxBps', type: 'uint16', indexed: false },
    { name: 'sellTaxBps', type: 'uint16', indexed: false }, { name: 'dividendBps', type: 'uint16', indexed: false },
    { name: 'recipient', type: 'address', indexed: true },
  ] },
  { type: 'event', name: 'Graduated', inputs: [
    { name: 'token', type: 'address', indexed: true }, { name: 'pair', type: 'address', indexed: true },
    { name: 'quote', type: 'address', indexed: false }, { name: 'tokenAmount', type: 'uint256', indexed: false },
    { name: 'quoteAmount', type: 'uint256', indexed: false },
  ] },
  { type: 'event', name: 'Buy', inputs: [
    { name: 'token', type: 'address', indexed: true }, { name: 'buyer', type: 'address', indexed: true },
    { name: 'quoteIn', type: 'uint256', indexed: false }, { name: 'protocolFee', type: 'uint256', indexed: false },
    { name: 'tax', type: 'uint256', indexed: false }, { name: 'tokensOut', type: 'uint256', indexed: false },
    { name: 'realQuote', type: 'uint256', indexed: false },
  ] },
  { type: 'event', name: 'Sell', inputs: [
    { name: 'token', type: 'address', indexed: true }, { name: 'seller', type: 'address', indexed: true },
    { name: 'tokensIn', type: 'uint256', indexed: false }, { name: 'protocolFee', type: 'uint256', indexed: false },
    { name: 'tax', type: 'uint256', indexed: false }, { name: 'quoteOut', type: 'uint256', indexed: false },
    { name: 'realQuote', type: 'uint256', indexed: false },
  ] },
  { type: 'function', name: 'buy', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }, { name: 'quoteIn', type: 'uint256' }, { name: 'minTokensOut', type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'sell', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }, { name: 'tokensIn', type: 'uint256' }, { name: 'minQuoteOut', type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'curves', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }], outputs: [
    { name: 'creator', type: 'address' }, { name: 'quote', type: 'address' }, { name: 'realQuote', type: 'uint128' },
    { name: 'sold', type: 'uint128' }, { name: 'gradAmt', type: 'uint128' }, { name: 'virtualQuote', type: 'uint128' },
    { name: 'graduated', type: 'bool' }, { name: 'buyTaxBps', type: 'uint16' }, { name: 'sellTaxBps', type: 'uint16' },
    { name: 'dividendBps', type: 'uint16' }, { name: 'pair', type: 'address' }, { name: 'refPair', type: 'address' },
  ] },
  { type: 'function', name: 'isAgent', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'walletRoom', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }, { name: 'buyer', type: 'address' }], outputs: [{ type: 'uint256' }] },
  ...['UnknownToken', 'AlreadyGraduated', 'ZeroAmount', 'Slippage', 'NotAgent', 'WalletCapReached'].map((name) => ({ type: 'error', name, inputs: [] })),
]

export const ERC20_ABI = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
]

export const WBNB_ABI = [{ type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] }]

/** Pancake V2 router: post-graduation exits. Fee-on-transfer variant because pool sells pay the token's sell tax. */
export const ROUTER_ABI = [
  { type: 'function', name: 'getAmountsOut', stateMutability: 'view', inputs: [{ name: 'amountIn', type: 'uint256' }, { name: 'path', type: 'address[]' }], outputs: [{ type: 'uint256[]' }] },
  { type: 'function', name: 'swapExactTokensForTokensSupportingFeeOnTransferTokens', stateMutability: 'nonpayable', inputs: [
    { name: 'amountIn', type: 'uint256' }, { name: 'amountOutMin', type: 'uint256' }, { name: 'path', type: 'address[]' },
    { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' },
  ], outputs: [] },
]
