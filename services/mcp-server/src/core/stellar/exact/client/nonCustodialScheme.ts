import {
  getNetworkPassphrase,
  getRpcUrl,
  isStellarNetwork,
  RpcConfig,
  validateStellarAssetAddress,
  validateStellarDestinationAddress,
} from "../../utils";
import {
  buildStandardTransferPayment,
  type BuildStandardTransferPaymentOpts,
} from "../../../../wallet/sessionPayment";
import type { PaymentPayload, PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";

/** Injectable builder type — defaults to the real buildStandardTransferPayment. */
type BuildPaymentFn = (opts: BuildStandardTransferPaymentOpts) => Promise<string>;

export type NonCustodialExactStellarSchemeOpts = {
  /** The caller's OpenZeppelin smart account contract address (C…) — the x402 `from`. */
  smartAccountId: string;
  /** The delegated session key secret (S…) authorizing the transfer. */
  sessionSecret: string;
  /** Optional custom RPC config (mainnet requires an explicit url). */
  rpcConfig?: RpcConfig;
  /** Optional injectable builder for offline unit tests. */
  buildPayment?: BuildPaymentFn;
};

/**
 * Non-custodial Stellar client implementation for the Exact payment scheme.
 *
 * Mirrors {@link ExactStellarScheme}'s interface, but instead of signing a
 * `USDC.transfer(from=signer, …)` with a single ed25519 key, it builds a STANDARD
 * x402 `USDC.transfer(from=smartAccount → payTo)` authorized SOLELY by the caller's
 * delegated session key (via {@link buildStandardTransferPayment}). The smart
 * account's OZ session delegation (spending-limit + expiry) is enforced on-chain at
 * settle. The resulting payload is fully standard, so the resource's own facilitator
 * settles it through the normal x402 flow.
 *
 * The session-key delegation requires the nested two-entry auth tree that the SDK's
 * `signAuthEntries` cannot emit — which is why this routes through the dedicated
 * builder rather than reusing the custodial scheme.
 */
export class NonCustodialExactStellarScheme implements SchemeNetworkClient {
  readonly scheme = "exact";

  private readonly smartAccountId: string;
  private readonly sessionSecret: string;
  private readonly rpcConfig?: RpcConfig;
  private readonly buildPayment: BuildPaymentFn;

  constructor(opts: NonCustodialExactStellarSchemeOpts) {
    this.smartAccountId = opts.smartAccountId;
    this.sessionSecret = opts.sessionSecret;
    this.rpcConfig = opts.rpcConfig;
    this.buildPayment = opts.buildPayment ?? buildStandardTransferPayment;
  }

  /**
   * Creates a standard x402 payment payload paying the resource from the caller's
   * smart account via the delegated session key.
   */
  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
  ): Promise<Pick<PaymentPayload, "x402Version" | "payload">> {
    try {
      this.validateRequirements(paymentRequirements);
    } catch (error) {
      throw new Error(`Invalid input parameters for creating Stellar payment, cause: ${error}`);
    }

    const { network, payTo, asset, amount } = paymentRequirements;

    const xdr = await this.buildPayment({
      usdcContractId: asset,
      smartAccountId: this.smartAccountId,
      payTo,
      amount,
      sessionSecret: this.sessionSecret,
      networkPassphrase: getNetworkPassphrase(network),
      rpcUrl: getRpcUrl(network, this.rpcConfig),
    });

    return {
      x402Version,
      payload: {
        transaction: xdr,
      },
    };
  }

  /**
   * Validates the payment requirements — same checks as the custodial scheme
   * (scheme/network/payTo/asset/amount).
   */
  private validateRequirements(paymentRequirements: PaymentRequirements): void {
    const { scheme, network, payTo, asset, amount } = paymentRequirements;

    if (typeof amount !== "string" || !Number.isInteger(Number(amount)) || Number(amount) <= 0) {
      throw new Error(`Invalid amount: ${amount}. Amount must be a positive integer.`);
    }

    if (scheme !== "exact") {
      throw new Error(`Unsupported scheme: ${scheme}`);
    }

    if (!isStellarNetwork(network)) {
      throw new Error(`Unsupported Stellar network: ${network}`);
    }

    if (!validateStellarDestinationAddress(payTo)) {
      throw new Error(`Invalid Stellar destination address: ${payTo}`);
    }

    if (!validateStellarAssetAddress(asset)) {
      throw new Error(`Invalid Stellar asset address: ${asset}`);
    }
  }
}
