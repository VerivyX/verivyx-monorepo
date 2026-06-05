import { randomUUID } from 'node:crypto';
import {
  HydrationFailedError,
  NoMatchingRequirementError,
  PaywallError,
  SettlementFailedError,
} from './errors.js';
import {
  GateResponse,
  PaymentPayload,
  PaymentRequired,
  PaymentRequirement,
  ResourceInfo,
  SettleRequest,
  SettlementResponse,
  X402_VERSION,
} from './types.js';
import { SignerFn } from './signer.js';

export interface PaywallAgentOptions {
  /** Origin of the hydration service, e.g. 'http://localhost:8082'. */
  apiBase: string;
  /** 'stellar:testnet' | 'stellar:pubnet'. Used to filter payment requirements. */
  network: 'stellar:testnet' | 'stellar:pubnet';
  /** Wallet signer — receives pre-built XDR, returns signed XDR. */
  signer: SignerFn;
  /** Optional fetch override (defaults to global fetch). */
  fetch?: typeof globalThis.fetch;
  /** Maximum amount (atomic units) the agent will pay per request. */
  maxAmountAtomic?: bigint;
}

export interface GetAccessOptions {
  domain: string;
  slug?: string;
}

export interface GetAccessResult {
  status: 'already_open' | 'paid_then_open';
  served: 'human' | 'paid_agent' | 'passthrough';
  transaction?: string;
}

/**
 * @deprecated Use GetAccessResult instead.
 */
export interface GetContentResult {
  status: 'served' | 'paid_then_served';
  content: { slug: string; title?: string; body: string; mimeType: string };
  transaction?: string;
  amount?: string;
}

/** Convert atomic USDC units (7 decimal) to Stellar decimal string. */
function atomicToStellar(atomic: string): string {
  return (Number(atomic) / 1e7).toFixed(7);
}

export class PaywallAgent {
  private readonly opts: Required<Pick<PaywallAgentOptions, 'apiBase' | 'network' | 'signer'>> &
    Pick<PaywallAgentOptions, 'fetch' | 'maxAmountAtomic'>;

  constructor(opts: PaywallAgentOptions) {
    if (!opts.apiBase) throw new PaywallError('config', 'apiBase is required');
    if (!opts.signer) throw new PaywallError('config', 'signer is required');
    if (opts.network !== 'stellar:testnet' && opts.network !== 'stellar:pubnet') {
      throw new PaywallError('config', `unsupported network: ${opts.network}`);
    }
    this.opts = {
      apiBase: opts.apiBase.replace(/\/$/, ''),
      network: opts.network,
      signer: opts.signer,
      fetch: opts.fetch ?? globalThis.fetch,
      maxAmountAtomic: opts.maxAmountAtomic,
    };
  }

  /**
   * Request access to paywalled content. If the agent already has an active
   * session (from a prior payment), returns immediately. Otherwise, fetches
   * payment requirements, builds and signs a Stellar Payment transaction, settles
   * it, and confirms access.
   *
   * After getAccess() resolves, the agent can retrieve content directly from the
   * creator's origin URL — the hydration service does NOT serve content bodies.
   */
  async getAccess(opts: GetAccessOptions): Promise<GetAccessResult> {
    const { domain, slug } = opts;

    // 1) Try hydrate first — if already paid or human, return immediately.
    const first = await this.hydrate(domain, slug ?? '');
    if (first.status === 'success') {
      return { status: 'already_open', served: first.served };
    }
    if (first.status !== 'payment_required') {
      throw new HydrationFailedError(first.statusCode, first.body);
    }

    // 2) Fetch payment requirements from the 402 body (already inline per x402 standard).
    const required = await this.fetchRequirements(domain, slug ?? '');
    const requirement = this.pickRequirement(required.accepts);
    this.assertWithinBudget(requirement);

    // 3) Build, sign, and settle via standard X402 X-PAYMENT header.
    //    settle() retries the hydrate endpoint with X-PAYMENT attached —
    //    no second hydrate call needed; settle confirms access inline.
    const settled = await this.settle(domain, slug ?? '', required.resource, requirement);
    if (!settled.success) {
      throw new SettlementFailedError(settled.errorReason ?? 'unknown', settled);
    }

    return {
      status: 'paid_then_open',
      served: 'paid_agent',
      transaction: settled.transaction,
    };
  }

  /**
   * @deprecated Content is no longer served by the hydration service.
   * Use getAccess() to verify/pay, then fetch content directly from the creator's URL.
   */
  async getContent(_domain: string, _slug: string): Promise<GetContentResult> {
    throw new PaywallError(
      'hydration',
      'getContent() is deprecated — content is now served directly from the creator origin. ' +
        'Use getAccess() to confirm access, then fetch from the creator URL.',
    );
  }

  // -----------------------------------------------------------------------

  async fetchRequirements(domain: string, slug: string): Promise<PaymentRequired> {
    const url = `${this.opts.apiBase}/api/v1/payment/requirements?domain=${encodeURIComponent(domain)}&slug=${encodeURIComponent(slug)}`;
    const r = await this.opts.fetch!(url, { method: 'GET' });
    if (r.status !== 402 && r.status !== 200) {
      const body = await r.text();
      throw new PaywallError('requirements', `requirements returned ${r.status}: ${body}`, {
        status: r.status,
      });
    }
    const json = (await r.json()) as PaymentRequired;
    if (!Array.isArray(json.accepts) || json.accepts.length === 0) {
      throw new NoMatchingRequirementError('server returned empty accepts[]');
    }
    return json;
  }

  pickRequirement(list: PaymentRequirement[]): PaymentRequirement {
    const isExactOnNetwork = (r: PaymentRequirement) =>
      r.scheme === 'exact' && r.network === this.opts.network;
    // Prefer classic Stellar USDC (asset contains ':' e.g. "USDC:GBBD47...")
    // because agent-sdk builds classic payment transactions.
    // Soroban entries (no ':') require invokeHostFunction TX which is a different path.
    const classic = list.find((r) => isExactOnNetwork(r) && r.asset.includes(':'));
    if (classic) return classic;
    const match = list.find(isExactOnNetwork);
    if (!match) {
      throw new NoMatchingRequirementError(
        `no scheme=exact requirement on network=${this.opts.network} (got ${list
          .map((r) => `${r.scheme}/${r.network}`)
          .join(', ')})`,
      );
    }
    return match;
  }

  assertWithinBudget(req: PaymentRequirement): void {
    const cap = this.opts.maxAmountAtomic;
    if (typeof cap !== 'bigint') return;
    let amt: bigint;
    try {
      amt = BigInt(req.amount);
    } catch {
      throw new PaywallError('payment', `requirement.amount is not an integer: ${req.amount}`);
    }
    if (amt > cap) {
      throw new PaywallError('payment', `amount ${amt} exceeds maxAmountAtomic ${cap}`);
    }
  }

  async settle(
    domain: string,
    slug: string,
    resource: ResourceInfo,
    requirement: PaymentRequirement,
  ): Promise<SettlementResponse> {
    const txXdr = await this.buildPaymentTx(requirement);
    const signedXdr = await this.opts.signer(txXdr);
    const payer = await this.extractPayer(signedXdr);

    // x402 v2 standard PaymentPayload: scheme/network inside "accepted" object.
    // Also include legacy top-level fields for backward compat with older Verivyx servers.
    const xPaymentPayload = {
      x402Version: X402_VERSION,
      accepted: {
        scheme: requirement.scheme,
        network: requirement.network,
        amount: requirement.amount,
        asset: requirement.asset,
        payTo: requirement.payTo,
        maxTimeoutSeconds: requirement.maxTimeoutSeconds,
        extra: requirement.extra,
      },
      // Legacy fields — hydration service accepts both formats
      scheme: requirement.scheme,
      network: requirement.network,
      payload: { transaction: signedXdr, payer },
    };
    const xPaymentHeader = Buffer.from(JSON.stringify(xPaymentPayload)).toString('base64');

    const r = await this.opts.fetch!(`${this.opts.apiBase}/api/v1/content/hydrate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'PAYMENT-SIGNATURE': xPaymentHeader, // x402 v2 spec
        'X-PAYMENT': xPaymentHeader,         // backward compat
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify({ domain, slug: slug || '' }),
    });

    const json = await r.json() as Record<string, unknown>;

    // Hydrate returns 200 { status: 'success', served: 'paid_agent', transaction }
    // when payment is accepted — map this to SettlementResponse.
    if (r.status === 200 && json['status'] === 'success') {
      return {
        success: true,
        transaction: (json['transaction'] as string) ?? '',
        network: requirement.network,
        payer,
        amount: requirement.amount,
      };
    }

    const errReason = (json['errorReason'] ?? json['error'] ?? `HTTP ${r.status}`) as string;
    throw new SettlementFailedError(errReason, json as unknown as SettlementResponse);
  }

  /**
   * Build an unsigned Stellar classic Payment transaction XDR.
   * Uses split payments from the requirement's extra field when available.
   * Amounts are converted from atomic units (7 decimals) to Stellar decimal format.
   */
  private async buildPaymentTx(requirement: PaymentRequirement): Promise<string> {
    const sdk = await import('@stellar/stellar-sdk');
    const { Networks, TransactionBuilder, Asset, Operation, Account } =
      sdk as typeof import('@stellar/stellar-sdk');

    const networkPassphrase =
      this.opts.network === 'stellar:pubnet' ? Networks.PUBLIC : Networks.TESTNET;

    // We need an account object to build the TX; the signer will provide
    // the public key during signing. We use a placeholder here — the signer
    // is expected to rebuild/amend the source if needed, or the settle endpoint
    // will fetch the real account.
    //
    // In practice, callers using createStellarSigner provide the secret key,
    // so we resolve the account from the SDK. But for a BYO signer, we need
    // to pass enough info for it to work. We build with a dummy sequence and
    // let the signer correct it.
    //
    // To properly support arbitrary signers, the agent builds a skeleton TX
    // that the signer must re-sequence. For createStellarSigner this is fine
    // since it rebuilds from XDR.
    //
    // IMPORTANT: the skeleton TX uses a placeholder source account. The signer
    // MUST set the correct source account and sequence before submitting.

    // Resolve split payments from requirement extra field.
    const splits = requirement.extra?.splitPayments as
      | Array<{ payTo: string; amount: string }>
      | undefined;

    // For XDR construction we need a real account. We use a well-known
    // testnet faucet address as source placeholder — signers should override.
    // This XDR is passed to signer which re-signs with the real key.
    const placeholderPublicKey = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';
    const account = new Account(placeholderPublicKey, '0');

    const txBuilder = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase,
    });

    const asset = requirement.asset === 'native' ? Asset.native() : (() => {
      // asset format: "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
      const [code, issuer] = requirement.asset.split(':');
      if (!code || !issuer) {
        throw new PaywallError('payment', `invalid asset format: ${requirement.asset}`);
      }
      return new Asset(code, issuer);
    })();

    if (splits && splits.length > 0) {
      // Split payments: Op 1 = creator share, Op 2 = platform fee.
      for (const split of splits) {
        txBuilder.addOperation(
          Operation.payment({
            destination: split.payTo,
            asset,
            amount: atomicToStellar(split.amount),
          }),
        );
      }
    } else {
      // Single payment to payTo.
      txBuilder.addOperation(
        Operation.payment({
          destination: requirement.payTo,
          asset,
          amount: atomicToStellar(requirement.amount),
        }),
      );
    }

    const tx = txBuilder.setTimeout(60).build();
    return tx.toEnvelope().toXDR('base64');
  }

  /**
   * Extract the source account (payer public key) from a signed XDR transaction.
   */
  private async extractPayer(signedXdr: string): Promise<string> {
    const sdk = await import('@stellar/stellar-sdk');
    const { TransactionBuilder, Networks, Transaction } = sdk as typeof import('@stellar/stellar-sdk');
    const networkPassphrase =
      this.opts.network === 'stellar:pubnet' ? Networks.PUBLIC : Networks.TESTNET;
    const tx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
    if (!(tx instanceof Transaction)) {
      throw new PaywallError('payment', 'expected a classic Transaction, not a FeeBumpTransaction');
    }
    return tx.source;
  }

  async hydrate(
    domain: string,
    slug: string,
  ): Promise<
    | (GateResponse & { statusCode: number; body: unknown })
    | { status: 'payment_required'; statusCode: number; body: unknown }
    | { status: 'error'; statusCode: number; body: unknown }
  > {
    const r = await this.opts.fetch!(`${this.opts.apiBase}/api/v1/content/hydrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain, slug }),
    });
    let parsed: unknown;
    try {
      parsed = await r.json();
    } catch {
      parsed = null;
    }
    if (r.status === 402) return { status: 'payment_required', statusCode: r.status, body: parsed };
    if (
      r.ok &&
      parsed !== null &&
      typeof parsed === 'object' &&
      'status' in parsed &&
      (parsed as Record<string, unknown>)['status'] === 'success' &&
      'served' in parsed
    ) {
      const gate = parsed as GateResponse;
      return {
        status: 'success',
        served: gate.served,
        transaction: gate.transaction,
        statusCode: r.status,
        body: parsed,
      };
    }
    return { status: 'error', statusCode: r.status, body: parsed };
  }
}
