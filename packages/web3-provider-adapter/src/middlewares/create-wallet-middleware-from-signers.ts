import { JsonRpcMiddleware } from "json-rpc-engine";
import { createWalletMiddleware } from "eth-json-rpc-middleware";

import tx from "@ethereumjs/tx";

import { Block } from "eth-json-rpc-middleware/dist/types.js";
import { Signer, Bytes } from "@cloud-cryptographic-wallet/signer";

import { query } from "../query.js";
import { getTransactionType } from "../parameters/get-transaction-type.js";
import { hasNonce } from "../type-guards/has-nonce.js";
import { getNonce } from "../ethereum-json-rpc/get-nonce.js";
import { hasFrom } from "../type-guards/has-from.js";
import { processSignature } from "../process-signature.js";
import { getCommon } from "../get-common.js";
import { assertKnownAddress } from "../parameters/assert-known-address.js";
import { getAccounts } from "../get-accounts.js";
import { lookupSigner } from "../lookup-signer.js";
import { getGas } from "../ethereum-json-rpc/get-gas.js";
import {
  SignTypedDataVersion,
  TypedDataUtils,
  TypedMessage,
} from "@metamask/eth-sig-util";

export function createWalletMiddlewareFromSigners(
  signers: Signer[],
  rpcUrl: string
): JsonRpcMiddleware<string, Block> {
  return createWalletMiddleware({
    getAccounts: () => {
      return getAccounts(signers);
    },

    processTypedMessageV4: async (msgParams) => {
      const { from, data } = msgParams;
      const signer = await lookupSigner(from, signers);
      if (!signer) {
        throw new Error(
          `createWalletMiddlewareFromSigners: from is unknown address. actual: ${from}`
        );
      }
      const typed = JSON.parse(data) as TypedMessage<any>;
      const messagehash = TypedDataUtils.eip712Hash(
        typed,
        SignTypedDataVersion.V4
      );
      const sig = await signer.sign(Bytes.fromArrayBuffer(messagehash));
      return sig.bytes.toString();
    },

    processTransaction: async (txParams) => {
      if (!hasFrom(txParams)) {
        throw new Error();
      }

      const { from } = txParams;
      const addresses = await getAccounts(signers);

      assertKnownAddress(from, addresses);

      const signer = await lookupSigner(from, signers);

      if (!signer) {
        throw new Error(
          `createWalletMiddlewareFromSigners: from is unknown address. actual: ${from}`
        );
      }

      const common = await getCommon(rpcUrl);

      const nonce = hasNonce(txParams)
        ? txParams.nonce
        : await getNonce(rpcUrl, from);

      const gas = await getGas(rpcUrl, txParams);

      const type = getTransactionType(txParams);
      const txData = {
        type,
        nonce,
        gasLimit: gas,
        ...txParams,
      };

      const unsignedTx = tx.TransactionFactory.fromTxData(txData, {
        common,
      });
      const hash = unsignedTx.getMessageToSign(true);

      const signature = await signer.sign(Bytes.fromArrayBuffer(hash));

      const signedTx = processSignature(unsignedTx, signature);

      const data = `0x${signedTx.serialize().toString("hex")}`;

      const result = await query<string>(rpcUrl, "eth_sendRawTransaction", [
        data,
      ]);

      if (!result) {
        throw new Error();
      }

      // https://github.com/MetaMask/eth-json-rpc-middleware/pull/111
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return result as any;
    },
  });
}
