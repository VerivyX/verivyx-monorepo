import { createPublicClient, createWalletClient, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner, type ClientEvmSigner } from "@x402/evm";
import type { x402Client } from "@x402/core/client";

import type { EvmChainConfig } from "../config.js";
import type { FeeReceipt } from "../fee/types.js";

const ERC20_TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export type EvmRail = {
  readonly address: `0x${string}`;
  /**
   * Charge the flat Verivyx MCP service fee as a SEPARATE ERC-20 USDC transfer to
   * the platform EVM treasury. The paying wallet broadcasts this (needs a little
   * native gas); on Base that is a fraction of a cent, far below the 0.001 fee.
   */
  chargeFee(feeUsdc: string): Promise<FeeReceipt>;
};

/** Build the EVM paying wallet and register its exact scheme on the shared x402 client. */
export function setupEvmRail(client: x402Client, config: EvmChainConfig): EvmRail {
  const account = privateKeyToAccount(config.privateKey);
  const chain = config.chainId === base.id ? base : baseSepolia;
  const transport = http(config.rpcUrl);

  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ account, chain, transport });

  // x402 client signer: a local account exposes top-level .address + signTypedData;
  // the public client supplies on-chain reads / nonce / fee estimation.
  const signer = toClientEvmSigner(
    account as unknown as Parameters<typeof toClientEvmSigner>[0],
    publicClient as unknown as Parameters<typeof toClientEvmSigner>[1],
  ) as ClientEvmSigner;

  registerExactEvmScheme(client, { signer, schemeOptions: { rpcUrl: config.rpcUrl } });

  async function chargeFee(feeUsdc: string): Promise<FeeReceipt> {
    const amount = parseUnits(feeUsdc, config.usdcDecimals);
    const txHash = await walletClient.writeContract({
      address: config.usdc,
      abi: ERC20_TRANSFER_ABI,
      functionName: "transfer",
      args: [config.feeTreasury, amount],
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    return {
      charged: true,
      asset: "USDC",
      amount: feeUsdc,
      to: config.feeTreasury,
      network: config.caip2,
      txHash,
    };
  }

  return { address: account.address, chargeFee };
}
