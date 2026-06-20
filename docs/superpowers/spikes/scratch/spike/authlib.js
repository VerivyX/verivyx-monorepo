"use strict";
// Manual construction of the OZ-smart-account auth-entry tree for a Delegated
// (ed25519 G-address) signer. Mirrors smart-account-kit's multi-signer-ops, but
// for a single delegated signer (the Verivyx session/owner-master key).
//
// THIS IS THE DELIVERABLE MECHANISM that sessionPayment.ts must build.
const S = require("@stellar/stellar-sdk");
const { Address, hash, xdr, Keypair } = S;

// Stellar default-account signature ScVal for an ed25519 G-address signer:
//   scvVec([ scvMap([ {public_key: bytes32}, {signature: bytes64} ]) ])
function ed25519SignatureScVal(gAddress, signatureBuf) {
  const pubKeyBytes = Address.fromString(gAddress).toScAddress().accountId().ed25519();
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("public_key"), val: xdr.ScVal.scvBytes(pubKeyBytes) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("signature"), val: xdr.ScVal.scvBytes(signatureBuf) }),
    ]),
  ]);
}

// Signatures(Map<Signer,Bytes>) ScVal — a single-field tuple struct → scvVec[ scvMap ].
// For Delegated signers the Bytes value is ignored by OZ (verification via require_auth_for_args).
function signaturesScVal(delegatedSignerAddresses) {
  const entries = delegatedSignerAddresses.map((addr) => new xdr.ScMapEntry({
    key: xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol("Delegated"),
      xdr.ScVal.scvAddress(Address.fromString(addr).toScAddress()),
    ]),
    val: xdr.ScVal.scvBytes(Buffer.alloc(0)),
  }));
  // sort map keys (Soroban requires sorted ScMap keys)
  entries.sort((a, b) => a.key().toXDR("hex").localeCompare(b.key().toXDR("hex")));
  return xdr.ScVal.scvVec([xdr.ScVal.scvMap(entries)]);
}

// Sign ALL Address-credential auth entries from a simulation so that the smart
// account `smartAccountId` is authorized by the single Delegated signer `signerSecret`.
//
// auths: array of xdr.SorobanAuthorizationEntry (from sim.result.auth)
// returns: array of signed xdr.SorobanAuthorizationEntry (smart-account entries
//          re-signed + appended delegated nested entries; others passed through).
function signDelegated({ auths, smartAccountId, signerSecret, networkPassphrase, expirationLedger }) {
  const signerKp = Keypair.fromSecret(signerSecret);
  const signerAddr = signerKp.publicKey();
  const networkId = hash(Buffer.from(networkPassphrase));
  const out = [];

  for (const entry0 of auths) {
    const entry = (typeof entry0 === "string")
      ? xdr.SorobanAuthorizationEntry.fromXDR(entry0, "base64")
      : xdr.SorobanAuthorizationEntry.fromXDR(entry0.toXDR()); // clone
    const cred = entry.credentials();
    if (cred.switch().name !== "sorobanCredentialsAddress") { out.push(entry); continue; }
    const authAddress = Address.fromScAddress(cred.address().address()).toString();

    if (authAddress !== smartAccountId) {
      // Not our smart account (e.g. a direct G-address require_auth) — leave as-is
      // (the source/other signer must handle it). For this spike the only Address
      // cred is the smart account.
      out.push(entry);
      continue;
    }

    // 1) Smart-account entry: set exp, attach Signatures map { Delegated(signer): empty }.
    entry.credentials().address().signatureExpirationLedger(expirationLedger);
    entry.credentials().address().signature(signaturesScVal([signerAddr]));
    out.push(entry);

    // 2) Compute the smart account's own signature payload hash.
    const saPreimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
      new xdr.HashIdPreimageSorobanAuthorization({
        networkId,
        nonce: entry.credentials().address().nonce(),
        signatureExpirationLedger: expirationLedger,
        invocation: entry.rootInvocation(),
      })
    );
    const signaturePayload = hash(saPreimage.toXDR());

    // 3) Build the Delegated signer's nested auth entry:
    //    root invocation = __check_auth(signaturePayload) on the smart account.
    const delegatedNonce = xdr.Int64.fromString(
      // unique-ish nonce; avoid collisions across multiple delegated entries.
      (BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000))).toString()
    );
    const delegatedInvocation = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(smartAccountId).toScAddress(),
          functionName: "__check_auth",
          args: [xdr.ScVal.scvBytes(signaturePayload)],
        })
      ),
      subInvocations: [],
    });
    const delegatedPreimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
      new xdr.HashIdPreimageSorobanAuthorization({
        networkId,
        nonce: delegatedNonce,
        signatureExpirationLedger: expirationLedger,
        invocation: delegatedInvocation,
      })
    );
    const delegatedPayloadHash = hash(delegatedPreimage.toXDR());
    const signatureBuf = signerKp.sign(delegatedPayloadHash);

    const delegatedEntry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: Address.fromString(signerAddr).toScAddress(),
          nonce: delegatedNonce,
          signatureExpirationLedger: expirationLedger,
          signature: ed25519SignatureScVal(signerAddr, signatureBuf),
        })
      ),
      rootInvocation: delegatedInvocation,
    });
    out.push(delegatedEntry);
  }
  return out;
}

module.exports = { signDelegated, signaturesScVal, ed25519SignatureScVal };
