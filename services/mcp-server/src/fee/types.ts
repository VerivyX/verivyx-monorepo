/** Receipt for the flat Verivyx MCP service fee charged on a successful payment. */
export type FeeReceipt = {
  charged: true;
  asset: "USDC";
  amount: string;
  to: string;
  network: string;
  txHash: string;
};
