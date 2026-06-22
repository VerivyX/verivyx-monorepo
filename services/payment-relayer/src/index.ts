import express from 'express';
import cors from 'cors';
import pino from 'pino';
import { Horizon, rpc, TransactionBuilder, Networks, Transaction, Keypair, Contract, Address, nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk';
import { resolvePayer, extractSorobanFrom, extractInvokedOp } from './payer';
import { payloadHash, settleOnce, SettleValidationError } from './idempotency';
import {
  parseAllowedPaywallContracts, assertPaywallContractAllowed,
  parseAllowedPayAdapters, assertAdapterAllowed,
  toStableError,
} from './validation';
import { classifySettlePath, SettlePath } from './routing';
import dotenv from 'dotenv';

dotenv.config();

const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN;
if (!INTERNAL_TOKEN) {
  console.error('INTERNAL_TOKEN env var is required');
  process.exit(1);
}

// Allowlist of official paywall_core contract addresses the relayer may fee-sponsor.
// Fail-closed: if empty/unset on the fee-sponsored path, settlement is rejected.
const ALLOWED_PAYWALL_CONTRACTS = parseAllowedPaywallContracts(process.env.ALLOWED_PAYWALL_CONTRACTS);

// Allowlist of official verivyx_pay_adapter contract addresses the relayer may fee-sponsor.
// Fail-closed: a tx targeting an adapter when this set is empty is REJECTED.
// On the adapter path the relayer only sponsors — it does NOT call distribute.
const ALLOWED_PAY_ADAPTERS = parseAllowedPayAdapters(process.env.ALLOWED_PAY_ADAPTERS);

const isDev = process.env.NODE_ENV !== 'production';
const logger = pino({
  ...(isDev && {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true }
    }
  })
});

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 8084;
const STELLAR_NETWORK = process.env.STELLAR_NETWORK || 'testnet';
const NETWORK_PASSPHRASE = STELLAR_NETWORK === 'testnet' ? Networks.TESTNET : Networks.PUBLIC;

// Allow override via env variables, fallback to SDF public nodes
const horizonUrl = process.env.HORIZON_URL || (STELLAR_NETWORK === 'testnet' ? 'https://horizon-testnet.stellar.org' : 'https://horizon.stellar.org');
const sorobanUrl = process.env.SOROBAN_URL || (STELLAR_NETWORK === 'testnet' ? 'https://soroban-testnet.stellar.org' : 'https://soroban-rpc.mainnet.stellar.org');

const horizonServer = new Horizon.Server(horizonUrl);
const sorobanServer = new rpc.Server(sorobanUrl);

// Canonical classic USDC issuer on Stellar testnet (well-known SDF test asset).
// Testnet is a sandbox, so this keeps it zero-config; mainnet moves real funds,
// so the issuer must be set explicitly via USDC_ISSUER.
const DEFAULT_TESTNET_USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
// Creators must hold a trustline to this asset to receive their USDC share.
const USDC_ISSUER = ((): string => {
  if (STELLAR_NETWORK === 'testnet') return process.env.USDC_ISSUER || DEFAULT_TESTNET_USDC_ISSUER;
  const issuer = process.env.USDC_ISSUER;
  if (!issuer) { console.error('USDC_ISSUER env var is required on mainnet'); process.exit(1); }
  return issuer;
})();

// Facilitator keypair — required for Soroban fee-sponsored settlements (areFeesSponsored: true).
// This account must hold XLM for transaction fees. Cost per TX ≈ 0.00001 XLM — far less than
// platform fee earned (0.001 USDC), so Verivyx does not lose money by sponsoring fees.
let facilitatorKeypair: Keypair | null = null;
const FACILITATOR_SECRET = process.env.FACILITATOR_STELLAR_SECRET;
if (FACILITATOR_SECRET) {
  try {
    facilitatorKeypair = Keypair.fromSecret(FACILITATOR_SECRET);
    logger.info({ publicKey: facilitatorKeypair.publicKey() }, 'Facilitator keypair loaded — Soroban fee sponsoring enabled');
  } catch {
    console.error('FACILITATOR_STELLAR_SECRET is set but invalid — Soroban fee sponsoring disabled');
  }
}

const X402Version = 2;

function atomicToStellar(atomic: string): string {
  return (Number(atomic) / 1e7).toFixed(7);
}

function requireInternalToken(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (req.headers['x-internal-token'] !== INTERNAL_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}


function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label}_timeout`)), ms)
    ),
  ]);
}

// Validate a x402-spec Soroban payment: exactly one invokeHostFunction calling
// `transfer(from, to, amount)` on the USDC contract, where to = the paywall contract
// (payTo) and amount = the full required amount. Prevents an agent from under-paying
// the contract while the keeper later distributes a larger amount from pooled funds.
function validateSorobanTransfer(
  tx: Transaction,
  usdcContract: string,
  expectedTo: string,
  expectedAmount: string,
): string | null {
  if (tx.operations.length !== 1) {
    return `Soroban TX must have exactly 1 operation, got ${tx.operations.length}`;
  }
  const op = tx.operations[0];
  if (op.type !== 'invokeHostFunction') {
    return `Soroban op must be invokeHostFunction, got ${op.type}`;
  }
  const hostFn = (op as unknown as { func: xdr.HostFunction }).func;
  if (hostFn.switch().name !== 'hostFunctionTypeInvokeContract') {
    return 'Soroban host function must be invokeContract';
  }
  const ic = hostFn.invokeContract();
  const contractAddr = Address.fromScAddress(ic.contractAddress()).toString();
  if (contractAddr !== usdcContract) {
    return `transfer must target USDC contract ${usdcContract}, got ${contractAddr}`;
  }
  if (ic.functionName().toString() !== 'transfer') {
    return `Soroban call must be transfer, got ${ic.functionName().toString()}`;
  }
  const args = ic.args();
  if (args.length !== 3) {
    return `transfer must have 3 args, got ${args.length}`;
  }
  const to = String(scValToNative(args[1]));
  const amount = String(scValToNative(args[2]));
  if (to !== expectedTo) {
    return `transfer recipient must be ${expectedTo}, got ${to}`;
  }
  if (amount !== expectedAmount) {
    return `transfer amount must be ${expectedAmount}, got ${amount}`;
  }
  return null;
}

// Validate a verivyx_pay_adapter.pay(owner, domain, slug) invocation:
// exactly one invokeHostFunction → invokeContract targeting the adapter, function `pay`, 3 args.
// Does NOT inspect arg values — the adapter contract enforces them on-chain.
function validateAdapterPayOp(
  tx: Transaction,
  expectedAdapterId: string,
): string | null {
  if (tx.operations.length !== 1) {
    return `Adapter TX must have exactly 1 operation, got ${tx.operations.length}`;
  }
  const op = tx.operations[0];
  if (op.type !== 'invokeHostFunction') {
    return `Adapter op must be invokeHostFunction, got ${op.type}`;
  }
  const hostFn = (op as unknown as { func: xdr.HostFunction }).func;
  if (hostFn.switch().name !== 'hostFunctionTypeInvokeContract') {
    return 'Adapter host function must be invokeContract';
  }
  const ic = hostFn.invokeContract();
  const contractAddr = Address.fromScAddress(ic.contractAddress()).toString();
  if (contractAddr !== expectedAdapterId) {
    return `Adapter pay must target adapter contract ${expectedAdapterId}, got ${contractAddr}`;
  }
  if (ic.functionName().toString() !== 'pay') {
    return `Adapter call must be pay, got ${ic.functionName().toString()}`;
  }
  const args = ic.args();
  if (args.length !== 3) {
    return `Adapter pay must have 3 args (owner, domain, slug), got ${args.length}`;
  }
  return null;
}

// Validate that all payment ops in TX use the expected asset (e.g. USDC:GBBD47...)
function validateAsset(tx: Transaction, asset: string): string | null {
  if (!asset || !asset.includes(':')) return null; // no requirement — skip
  const [expectedCode, expectedIssuer] = asset.split(':');
  for (const op of tx.operations) {
    if (op.type !== 'payment') continue;
    const payOp = op as { type: 'payment'; asset: { code: string; issuer?: string }; destination: string; amount: string };
    const opCode = payOp.asset.code;
    const opIssuer = payOp.asset.issuer ?? '';
    if (opCode !== expectedCode || opIssuer !== expectedIssuer) {
      return `Wrong asset in payment op: expected ${asset}, got ${opCode}:${opIssuer}`;
    }
  }
  return null;
}

app.get('/supported', (req, res) => {
  res.json({
    kinds: [
      { x402Version: X402Version, scheme: 'exact', network: 'stellar:' + STELLAR_NETWORK }
    ],
    extensions: [],
    signers: {
      'stellar:*': ['payment-relayer']
    }
  });
});

// Trustline / payout-readiness check for a creator account. The frontend uses
// the returned asset + network config to build the changeTrust the creator
// signs (non-custodial) to enable receiving USDC.
app.get('/trustline', requireInternalToken, async (req, res) => {
  const account = String(req.query.account || '');
  if (!/^G[A-Z2-7]{55}$/.test(account)) {
    return res.status(400).json({ error: 'valid account required' });
  }
  try {
    let funded = true;
    let hasTrustline = false;
    let usdcBalance = '0';
    let xlmBalance = '0';
    try {
      const acct = await withTimeout(horizonServer.loadAccount(account), 10000, 'horizon_load');
      for (const b of acct.balances) {
        if (b.asset_type === 'native') {
          xlmBalance = b.balance;
        } else if (
          (b.asset_type === 'credit_alphanum4' || b.asset_type === 'credit_alphanum12') &&
          b.asset_code === 'USDC' &&
          b.asset_issuer === USDC_ISSUER
        ) {
          hasTrustline = true;
          usdcBalance = b.balance;
        }
      }
    } catch (e: unknown) {
      const status = (e as { response?: { status?: number } })?.response?.status;
      if (status === 404) {
        funded = false; // account not created on-chain yet
      } else {
        throw e;
      }
    }
    res.json({
      account,
      funded,
      hasTrustline,
      usdcBalance,
      xlmBalance,
      asset: { code: 'USDC', issuer: USDC_ISSUER },
      network: STELLAR_NETWORK === 'testnet' ? 'testnet' : 'public',
      networkPassphrase: NETWORK_PASSPHRASE,
      horizonUrl,
    });
  } catch (err: unknown) {
    logger.error({ err }, 'trustline check failed');
    res.status(502).json({ error: 'horizon_unreachable' });
  }
});

app.post('/verify', requireInternalToken, async (req, res) => {
  const { paymentPayload, paymentRequirements } = req.body;
  if (!paymentPayload || !paymentPayload.payload || !paymentPayload.payload.transaction) {
    return res.status(400).json({ isValid: false, invalidReason: 'Missing transaction XDR' });
  }

  try {
    const tx = TransactionBuilder.fromXDR(paymentPayload.payload.transaction, NETWORK_PASSPHRASE) as Transaction;
    
    // 1. Verify that the transaction actually has signatures attached.
    // Exception: Soroban fee-sponsored path (x402 spec) — client signs auth entries only,
    // not the TX envelope. The facilitator signs as TX source during settlement.
    const isSorobanTx = tx.operations.some(op => op.type === 'invokeHostFunction');
    if (!isSorobanTx && (!tx.signatures || tx.signatures.length === 0)) {
      return res.status(400).json({ isValid: false, invalidReason: 'Transaction is missing signatures' });
    }

    // 2. Revenue Split Verification (Production POV)
    // If the requirements specify a split, the transaction MUST contain operations fulfilling it.
    const extra = paymentRequirements?.extra;
    if (extra && Array.isArray(extra.splitPayments)) {
      logger.info({ split: extra.splitPayments }, 'Verifying revenue split');

      const paymentOps = tx.operations.filter(op => op.type === 'payment');
      if (paymentOps.length !== 2) {
        logger.warn({ count: paymentOps.length }, 'TX must have exactly 2 payment operations');
        return res.status(400).json({
          isValid: false,
          invalidReason: `Expected exactly 2 payment operations, got ${paymentOps.length}`,
        });
      }

      for (const split of extra.splitPayments) {
        // Find a payment operation that matches this split requirement
        const match = tx.operations.find(op =>
          op.type === 'payment' &&
          op.destination === split.payTo &&
          op.amount === atomicToStellar(split.amount)
        );

        if (!match) {
          logger.warn({ split, txOps: tx.operations }, 'Split payment missing from transaction');
          return res.status(400).json({
            isValid: false,
            invalidReason: `Transaction missing required split payment of ${split.amount} to ${split.payTo} (${split.role})`
          });
        }
      }
    }

    // 3. Asset validation — ensure all payment ops use the correct asset
    const assetErr = validateAsset(tx, paymentRequirements?.asset ?? '');
    if (assetErr) {
      logger.warn({ assetErr }, 'Asset validation failed in /verify');
      return res.status(400).json({ isValid: false, invalidReason: assetErr });
    }

    res.json({ isValid: true, payer: tx.source });
  } catch (err: any) {
    logger.error({ err }, 'Failed to parse XDR for verification');
    res.status(400).json({ isValid: false, invalidReason: 'Invalid XDR format' });
  }
});

async function pollSorobanConfirmation(hash: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const statusRes = await sorobanServer.getTransaction(hash);
    if (statusRes.status === rpc.Api.GetTransactionStatus.SUCCESS) return hash;
    if (statusRes.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(`Soroban TX failed: ${JSON.stringify(statusRes.resultXdr)}`);
    }
  }
  throw new Error('Soroban TX timeout waiting for confirmation');
}

// submitSoroban submits a pre-signed Soroban TX as-is (client is the TX source).
// Used for legacy Soroban contract calls where the client signs the full transaction.
async function submitSoroban(txXdr: string): Promise<string> {
  const tx = TransactionBuilder.fromXDR(txXdr, NETWORK_PASSPHRASE);
  logger.info({ sorobanUrl }, 'Submitting pre-signed Soroban TX');
  const sendRes = await sorobanServer.sendTransaction(tx);
  if (sendRes.status === 'ERROR') {
    throw new Error(`Soroban send error: ${JSON.stringify(sendRes.errorResult)}`);
  }
  return pollSorobanConfirmation(sendRes.hash);
}

// submitSorobanAsFeeSponsor handles x402 spec-compliant Soroban payments where the
// client only signs authorization entries (not the TX envelope). The facilitator:
//   1. Rebuilds the TX with its own account as source (covering XLM fees)
//   2. Simulates to get soroban resource data
//   3. Signs and submits
// Cost per TX ≈ 0.00001 XLM — covered by the platform fee (0.001 USDC).
async function submitSorobanAsFeeSponsor(txXdr: string): Promise<string> {
  if (!facilitatorKeypair) {
    throw new Error('FACILITATOR_STELLAR_SECRET required for fee-sponsored Soroban submission');
  }

  // Parse client TX to extract operations (with their signed auth entries)
  const clientTx = TransactionBuilder.fromXDR(txXdr, NETWORK_PASSPHRASE) as Transaction;

  // Load facilitator's current sequence number from Soroban RPC
  const facilitatorAccount = await sorobanServer.getAccount(facilitatorKeypair.publicKey());

  // Rebuild TX with facilitator as source, preserving all ops and their auth entries
  const txBuilder = new TransactionBuilder(facilitatorAccount, {
    fee: '10000000', // 1 XLM max fee budget — actual fee determined by simulation
    networkPassphrase: NETWORK_PASSPHRASE,
  }).setTimeout(30);

  // Copy XDR operations (preserves invokeHostFunction auth entries).
  // clientTx.tx is xdr.Transaction — operations() returns xdr.Operation[].
  for (const op of (clientTx as unknown as { tx: { operations(): unknown[] } }).tx.operations()) {
    txBuilder.addOperation(op as Parameters<typeof txBuilder.addOperation>[0]);
  }

  const tx = txBuilder.build();

  // Simulate against current ledger state to get resource limits and footprint
  const simResult = await sorobanServer.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(simResult)) {
    const errResult = simResult as rpc.Api.SimulateTransactionErrorResponse;
    throw new Error(`Soroban simulation failed: ${errResult.error}`);
  }

  // Assemble: merges simulation soroban data (footprint, resource limits) into TX
  const assembled = rpc.assembleTransaction(tx, simResult).build();

  // Sign with facilitator key (the TX source)
  assembled.sign(facilitatorKeypair);

  logger.info({ facilitator: facilitatorKeypair.publicKey(), sorobanUrl }, 'Submitting fee-sponsored Soroban TX');
  const sendRes = await sorobanServer.sendTransaction(assembled);
  if (sendRes.status === 'ERROR') {
    throw new Error(`Soroban send error: ${JSON.stringify(sendRes.errorResult)}`);
  }
  return pollSorobanConfirmation(sendRes.hash);
}

// callDistribute invokes paywall_core.distribute(domain, usdc, amount) as the keeper.
// Runs AFTER the agent's single x402 transfer has landed USDC in the paywall contract.
// The contract splits its own balance: (amount − platform_fee) → creator, fee → platform.
// Signed + fee-paid by the facilitator (which is the registered keeper). Cost ≈ 0.00001 XLM.
async function callDistribute(
  paywallContract: string,
  domain: string,
  usdcToken: string,
  amount: string,
): Promise<string> {
  if (!facilitatorKeypair) {
    throw new Error('FACILITATOR_STELLAR_SECRET required for distribute');
  }
  const contract = new Contract(paywallContract);
  const account = await sorobanServer.getAccount(facilitatorKeypair.publicKey());

  const op = contract.call(
    'distribute',
    nativeToScVal(domain, { type: 'string' }),
    new Address(usdcToken).toScVal(),
    nativeToScVal(BigInt(amount), { type: 'i128' }),
  );

  const tx = new TransactionBuilder(account, {
    fee: '10000000', // 1 XLM budget — real fee from simulation
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();

  const sim = await sorobanServer.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim)) {
    const errSim = sim as rpc.Api.SimulateTransactionErrorResponse;
    throw new Error(`distribute simulation failed: ${errSim.error}`);
  }

  const assembled = rpc.assembleTransaction(tx, sim).build();
  assembled.sign(facilitatorKeypair);

  logger.info({ paywallContract, domain, amount }, 'Calling contract.distribute()');
  const sendRes = await sorobanServer.sendTransaction(assembled);
  if (sendRes.status === 'ERROR') {
    throw new Error(`distribute send error: ${JSON.stringify(sendRes.errorResult)}`);
  }
  return pollSorobanConfirmation(sendRes.hash);
}

async function submitClassic(txXdr: string): Promise<string> {
  const tx = TransactionBuilder.fromXDR(txXdr, NETWORK_PASSPHRASE) as Transaction;
  logger.info(`Submitting Classic TX to ${horizonUrl}`);
  try {
    const res = await horizonServer.submitTransaction(tx);
    return res.hash;
  } catch (e: any) {
    const codes = e?.response?.data?.extras?.result_codes || e.message;
    throw new Error(`Horizon submit error: ${JSON.stringify(codes)}`);
  }
}

app.post('/settle', requireInternalToken, async (req, res) => {
  const { x402Version, paymentPayload, paymentRequirements } = req.body;
  if (!paymentPayload || !paymentPayload.payload || !paymentPayload.payload.transaction) {
    return res.status(400).json({ success: false, errorReason: 'Missing transaction XDR' });
  }

  // Derive the dedupe key server-side from the transaction XDR (not from a caller header).
  // This prevents double-spend when the caller omits or rotates the idempotency header.
  const txXdr = paymentPayload.payload.transaction;
  const key = payloadHash(txXdr);

  let tx: Transaction;
  try {
    tx = TransactionBuilder.fromXDR(txXdr, NETWORK_PASSPHRASE) as Transaction;

    // --- REVENUE SPLIT VERIFICATION ---
    const extra = paymentRequirements?.extra;
    if (extra && Array.isArray(extra.splitPayments)) {
      logger.info({ split: extra.splitPayments }, 'Settle: Verifying revenue split');

      const paymentOps = tx.operations.filter(op => op.type === 'payment');
      if (paymentOps.length !== 2) {
        logger.warn({ count: paymentOps.length }, 'Settle: TX must have exactly 2 payment operations');
        return res.status(400).json({
          success: false,
          errorReason: `Expected exactly 2 payment operations, got ${paymentOps.length}`,
        });
      }

      for (const split of extra.splitPayments) {
        const match = tx.operations.find(op =>
          op.type === 'payment' &&
          op.destination === split.payTo &&
          op.amount === atomicToStellar(split.amount)
        );
        if (!match) {
          logger.warn({ split }, 'Settle: Split payment missing');
          return res.status(400).json({
            success: false,
            errorReason: `Transaction missing required split payment of ${split.amount} to ${split.payTo}`
          });
        }
      }
    }

    // Asset validation — ensure all payment ops use the correct asset
    const assetErr = validateAsset(tx, paymentRequirements?.asset ?? '');
    if (assetErr) {
      logger.warn({ assetErr }, 'Asset validation failed in /settle');
      return res.status(400).json({ success: false, errorReason: assetErr });
    }
  } catch (err: unknown) {
    logger.error({ err }, 'Failed to parse XDR in /settle');
    return res.status(400).json({ success: false, errorReason: 'Invalid XDR' });
  }

  try {
    const result = await settleOnce(key, async () => {
      const isSoroban = tx.operations.some(op => op.type === 'invokeHostFunction');
      // x402 spec-compliant Soroban: client signs auth entries only, TX has no envelope signature.
      // Facilitator rebuilds TX as source and covers XLM fees (areFeesSponsored: true).
      const needsFeeSponsoring = isSoroban && tx.signatures.length === 0 && !!facilitatorKeypair;

      if (isSoroban && needsFeeSponsoring) {
        // Extract the invoked contract + function to determine the routing path.
        const invokedOp = extractInvokedOp(tx);
        if (!invokedOp) {
          throw new SettleValidationError('Soroban TX must have exactly one invokeHostFunction → invokeContract operation');
        }

        const settlePath = classifySettlePath(invokedOp, ALLOWED_PAY_ADAPTERS);

        if (settlePath === SettlePath.ADAPTER) {
          // --- ADAPTER PATH (verivyx_pay_adapter.pay) ---
          // The adapter performs the 3-way split atomically inside itself.
          // Relayer ONLY fee-sponsors — distribute must NOT be called here.

          // Fail-closed allowlist assertion (throws SettleValidationError → 400 if not allowed).
          assertAdapterAllowed(invokedOp.contractId, ALLOWED_PAY_ADAPTERS);

          // Validate op shape: exactly one invokeHostFunction → adapter.pay with 3 args.
          const aErr = validateAdapterPayOp(tx, invokedOp.contractId);
          if (aErr) {
            logger.warn({ aErr }, 'Adapter pay op validation failed in /settle');
            throw new SettleValidationError(aErr);
          }

          logger.info({ adapterId: invokedOp.contractId }, 'Adapter path: sponsor-only (no distribute)');
          const txHash = await withTimeout(submitSorobanAsFeeSponsor(txXdr), 30000, 'soroban_sponsor_submit');

          const payer = resolvePayer(paymentPayload?.payload?.payer, extractSorobanFrom(tx), tx.source);
          logger.info({ txHash }, 'Adapter payment settled (sponsor-only, split done atomically in adapter)');
          return {
            success: true,
            transaction: txHash,
            distributeTransaction: undefined,
            network: paymentRequirements.network,
            payer,
            amount: paymentRequirements.amount,
          };
        }

        // --- LEGACY PAYWALL PATH ---
        // assertPaywallContractAllowed throws SettleValidationError (→ 400) if not allowed.
        const pc: string | undefined = paymentRequirements?.extra?.paywallContract;
        assertPaywallContractAllowed(pc, ALLOWED_PAYWALL_CONTRACTS);
        const tErr = validateSorobanTransfer(tx, paymentRequirements.asset, pc as string, paymentRequirements.amount);
        if (tErr) {
          logger.warn({ tErr }, 'Soroban transfer validation failed in /settle');
          throw new SettleValidationError(tErr);
        }

        const txHash = await withTimeout(submitSorobanAsFeeSponsor(txXdr), 30000, 'soroban_sponsor_submit');

        // x402 spec Soroban path: the agent's single transfer just landed the full amount
        // in the paywall contract. Now run the on-chain split via distribute().
        // Gateway passes domain + paywallContract in paymentRequirements.extra.
        let distributeTx: string | undefined;
        const extra = paymentRequirements?.extra;
        const paywallContract: string | undefined = extra?.paywallContract;
        const distributeDomain: string | undefined = extra?.domain;
        if (paywallContract && distributeDomain) {
          distributeTx = await withTimeout(
            callDistribute(paywallContract, distributeDomain, paymentRequirements.asset, paymentRequirements.amount),
            30000,
            'soroban_distribute',
          );
          logger.info({ distributeTx }, 'On-chain split completed via distribute()');
        }

        const payer = resolvePayer(paymentPayload?.payload?.payer, extractSorobanFrom(tx), tx.source);
        logger.info({ txHash, distributeTx }, 'Payment settled successfully');
        return {
          success: true,
          transaction: txHash,
          distributeTransaction: distributeTx,
          network: paymentRequirements.network,
          payer,
          amount: paymentRequirements.amount,
        };
      }

      // --- NON-FEE-SPONSORED SOROBAN OR CLASSIC PATH ---
      let txHash: string;
      if (isSoroban) {
        // Pre-flight simulate the already-signed legacy tx before submitting.
        // Simulation is a read-only error check; we do NOT assemble/resign (that
        // would invalidate the client's signature). Submit the original tx as-is.
        const legacyTx = TransactionBuilder.fromXDR(txXdr, NETWORK_PASSPHRASE);
        const legacySim = await sorobanServer.simulateTransaction(legacyTx);
        if (!rpc.Api.isSimulationSuccess(legacySim)) {
          logger.error({ legacySim }, 'Legacy Soroban pre-flight simulation failed');
          throw new Error('soroban_legacy_sim_failed');
        }
        txHash = await withTimeout(submitSoroban(txXdr), 15000, 'soroban_submit');
      } else {
        txHash = await withTimeout(submitClassic(txXdr), 15000, 'horizon_submit');
      }

      const payer = resolvePayer(paymentPayload?.payload?.payer, extractSorobanFrom(tx), tx.source);
      logger.info({ txHash }, 'Payment settled successfully');
      return {
        success: true,
        transaction: txHash,
        distributeTransaction: undefined,
        network: paymentRequirements.network,
        payer,
        amount: paymentRequirements.amount,
      };
    });

    res.json(result);
  } catch (err: unknown) {
    if (err instanceof SettleValidationError) {
      return res.status(400).json({ success: false, errorReason: err.message });
    }
    const { status, reason } = toStableError(err);
    logger.error({ err }, 'settle failed');
    res.status(status).json({
      success: false,
      errorReason: reason,
      transaction: '',
      network: paymentRequirements.network,
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'payment-relayer' });
});

app.listen(PORT, () => {
  logger.info(`payment-relayer listening on port ${PORT} (Network: ${STELLAR_NETWORK})`);
});
