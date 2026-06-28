/** Convert USDC price/fee (floats) to atomic i128 BigInts with the contract's guard. */
export function toRegisterArgs(input: { price: number; platformFee: number }): { priceAtomic: bigint; feeAtomic: bigint } {
  const priceAtomic = BigInt(Math.round(input.price * 1e7));
  const feeAtomic = BigInt(Math.round(input.platformFee * 1e7));
  if (priceAtomic <= 0n || feeAtomic < 0n || feeAtomic >= priceAtomic) {
    throw new Error('invalid_price');
  }
  return { priceAtomic, feeAtomic };
}
