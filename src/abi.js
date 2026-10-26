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

/** FairMintPad (打新), gang-launchpad main src/fair-mint/FairMintPad.sol */
export const FAIR_ABI = [
  { type: 'event', name: 'Created', inputs: [
    { name: 'token', type: 'address', indexed: true }, { name: 'creator', type: 'address', indexed: true },
    { name: 'name', type: 'string', indexed: false }, { name: 'symbol', type: 'string', indexed: false },
    { name: 'logoURI', type: 'string', indexed: false }, { name: 'quote', type: 'address', indexed: true },
    { name: 'refPool', type: 'address', indexed: false }, { name: 'raiseBnb', type: 'uint256', indexed: false },
    { name: 'sharePrice', type: 'uint256', indexed: false }, { name: 'capShares', type: 'uint256', indexed: false },
    { name: 'deadline', type: 'uint256', indexed: false }, { name: 'holdBps', type: 'uint256', indexed: false },
    { name: 'mintFeeBps', type: 'uint256', indexed: false }, { name: 'exitFeeBps', type: 'uint256', indexed: false },
  ] },
  { type: 'event', name: 'Minted', inputs: [
    { name: 'token', type: 'address', indexed: true }, { name: 'user', type: 'address', indexed: true },
    { name: 'shares', type: 'uint256', indexed: false }, { name: 'cost', type: 'uint256', indexed: false },
    { name: 'fee', type: 'uint256', indexed: false }, { name: 'userShares', type: 'uint256', indexed: false },
    { name: 'sold', type: 'uint256', indexed: false },
  ] },
  { type: 'event', name: 'Launched', inputs: [
    { name: 'token', type: 'address', indexed: true }, { name: 'pair', type: 'address', indexed: true },
    { name: 'quote', type: 'address', indexed: false }, { name: 'tokenAmount', type: 'uint256', indexed: false },
    { name: 'quoteAmount', type: 'uint256', indexed: false }, { name: 'feeToPlatform', type: 'uint256', indexed: false },
  ] },
  { type: 'event', name: 'Refunded', inputs: [
    { name: 'token', type: 'address', indexed: true }, { name: 'user', type: 'address', indexed: true },
    { name: 'amount', type: 'uint256', indexed: false },
  ] },
  { type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }, { name: 'shares', type: 'uint256' }, { name: 'minShares', type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'refund', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'status', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'previewMint', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }, { name: 'user', type: 'address' }, { name: 'shares', type: 'uint256' }], outputs: [{ name: 'accepted', type: 'uint256' }, { name: 'cost', type: 'uint256' }, { name: 'fee', type: 'uint256' }] },
  { type: 'function', name: 'baselineOf', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }, { name: 'user', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'holdBpsOf', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }], outputs: [{ type: 'uint16' }] },
  { type: 'function', name: 'sales', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }], outputs: [
    { name: 'creator', type: 'address' }, { name: 'deadline', type: 'uint64' }, { name: 'capShares', type: 'uint16' },
    { name: 'holdBps', type: 'uint16' }, { name: 'quote', type: 'address' }, { name: 'sold', type: 'uint16' },
    { name: 'launched', type: 'bool' }, { name: 'failed', type: 'bool' }, { name: 'mintFeeBps', type: 'uint16' },
    { name: 'exitFeeBps', type: 'uint16' }, { name: 'gate', type: 'address' }, { name: 'sharePrice', type: 'uint128' },
    { name: 'escrowedFee', type: 'uint128' }, { name: 'pair', type: 'address' }, { name: 'refPool', type: 'address' },
  ] },
  ...['UnknownToken', 'NotMinting', 'NotFailed', 'ZeroAmount', 'BadAmount', 'Slippage', 'WalletCapReached', 'NothingToRefund', 'NotAgent', 'FeeOnTransferQuote'].map((name) => ({ type: 'error', name, inputs: [] })),
]

/** Fair sale status enum (FairMintPad.Status). */
export const FAIR_STATUS = ['None', 'Minting', 'Launched', 'Failed']
