/**
 * 1Click API types. Source: https://1click.chaindefuser.com/docs/v0/openapi.yaml
 * read 2026-10-25. Field names match the API exactly.
 */

export const ONECLICK_BASE_URL = "https://1click.chaindefuser.com";

export type SwapType = "EXACT_INPUT" | "EXACT_OUTPUT" | "FLEX_INPUT" | "ANY_INPUT";
export type DepositType = "ORIGIN_CHAIN" | "INTENTS" | "CONFIDENTIAL_INTENTS";
export type RefundType = "ORIGIN_CHAIN" | "INTENTS" | "CONFIDENTIAL_INTENTS";
export type RecipientType = "DESTINATION_CHAIN" | "INTENTS" | "CONFIDENTIAL_INTENTS";
export type DepositMode = "SIMPLE" | "MEMO";
export type Confidentiality = "public" | "basic" | "advanced";

export interface AppFee {
  recipient: string;
  /** Basis points, integer. */
  fee: number;
}

export interface Rebate {
  recipient: string;
  share: number;
}

export interface QuoteRequest {
  /** true returns a quote with no deposit address and no commitment. */
  dry: boolean;
  swapType: SwapType;
  /** Basis points. */
  slippageTolerance: number;
  originAsset: string;
  depositType: DepositType;
  destinationAsset: string;
  /** Integer string in base units of the origin asset. */
  amount: string;
  refundTo: string;
  refundType: RefundType;
  recipient: string;
  recipientType: RecipientType;
  /** ISO 8601 date-time. Deposit must arrive before this. */
  deadline: string;
  depositMode?: DepositMode;
  connectedWallets?: string[];
  sessionId?: string;
  virtualChainRecipient?: string;
  virtualChainRefundRecipient?: string;
  customRecipientMsg?: string;
  confidentiality?: Confidentiality;
  referral?: string;
  rebates?: Rebate[];
  quoteWaitingTimeMs?: number;
  appFees?: AppFee[];
  insured?: boolean;
}

export interface ChainDepositAddress {
  blockchain: string;
  address: string;
  memo?: string;
}

export interface Quote {
  amountIn: string;
  amountInFormatted: string;
  amountInUsd: string;
  minAmountIn: string;
  amountOut: string;
  amountOutFormatted: string;
  amountOutUsd: string;
  minAmountOut: string;
  /** Seconds. */
  timeEstimate: number;
  depositAddress?: string;
  depositMemo?: string;
  chainDepositAddresses?: ChainDepositAddress[];
  deadline?: string;
  timeWhenInactive?: string;
  virtualChainRecipient?: string;
  virtualChainRefundRecipient?: string;
  customRecipientMsg?: string;
  refundFee?: string;
  withdrawFee?: string;
}

export interface QuoteResponse {
  correlationId: string;
  timestamp: string;
  /** 1Click's signature over the quote. Keep it with the quote. */
  signature: string;
  quoteRequest: QuoteRequest;
  quote: Quote;
}

export type SwapStatus =
  | "KNOWN_DEPOSIT_TX"
  | "PENDING_DEPOSIT"
  | "INCOMPLETE_DEPOSIT"
  | "PROCESSING"
  | "SUCCESS"
  | "REFUNDED"
  | "FAILED";

export const FINAL_SWAP_STATUSES: ReadonlySet<SwapStatus> = new Set<SwapStatus>(["SUCCESS", "REFUNDED", "FAILED"]);

export interface TxRef {
  hash: string;
  explorerUrl: string;
}

export interface SwapDetails {
  intentHashes: string[];
  nearTxHashes: string[];
  originChainTxHashes: TxRef[];
  destinationChainTxHashes: TxRef[];
  amountIn?: string;
  amountInFormatted?: string;
  amountInUsd?: string;
  amountOut?: string;
  amountOutFormatted?: string;
  amountOutUsd?: string;
  slippage?: number;
  refundedAmount?: string;
  refundedAmountFormatted?: string;
  refundedAmountUsd?: string;
  refundReason?: string;
  depositedAmount?: string;
  depositedAmountFormatted?: string;
  depositedAmountUsd?: string;
  withdrawFee?: string;
  referral?: string;
}

export interface StatusResponse {
  correlationId: string;
  quoteResponse: QuoteResponse;
  status: SwapStatus;
  updatedAt: string;
  swapDetails: SwapDetails;
}

export interface SubmitDepositRequest {
  txHash: string;
  depositAddress: string;
  /** NEAR origin only. */
  nearSenderAccount?: string;
  memo?: string;
}

export interface TokenInfo {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  /** USD. */
  price: number;
  priceUpdatedAt: string;
  contractAddress?: string;
  coingeckoId?: string;
}
