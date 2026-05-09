import {
  createSwapFromSuiMoveCalls,
  Quote as MayanQuote,
  swapFromSolana,
  swapFromEvm,
  SolanaTransactionSigner,
  JitoBundleOptions,
  Erc20Permit,
  addresses,
} from "@mayanfinance/swap-sdk";
import { Buffer } from "node:buffer";
import { BridgeSwapQuote } from "../../../types";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { Connection, SendOptions } from "@solana/web3.js";
import { Signer, Overrides, Contract, parseUnits } from "ethers";

const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
];

type SuiWalletConnection = {
  provider: ClientWithCoreApi;
  signTransaction: (data: { transaction: Transaction }) => Promise<{
    bytes: string;
    signature: string;
  }>;
};

type SolanaWalletConnection = {
  signTransaction: SolanaTransactionSigner;
  connection: Connection;
  extraRpcs?: string[];
  sendOptions?: SendOptions;
  jitoOptions?: JitoBundleOptions;
};

type EVMWalletConnection = {
  overrides: Overrides | null | undefined;
  signer: Signer;
  permit: Erc20Permit | null | undefined;
  waitForTransaction: (data: {
    hash: string;
    confirmations: number;
  }) => Promise<void>;
};

export type WalletConnection = {
  sui?: SuiWalletConnection;
  solana?: SolanaWalletConnection;
  evm?: EVMWalletConnection;
};

enum BridgeChain {
  SUI = 1999,
  SOLANA = 0,
}

export async function swap(
  route: BridgeSwapQuote,
  fromAddress: string,
  toAddress: string,
  walletConnection: WalletConnection,
  referrerAddresses?: {
    sui?: string;
    evm?: string;
    solana?: string;
  }
): Promise<string> {
  if (!route) {
    throw new Error("No route found");
  }
  const mayanQuote = route.info_for_bridge as MayanQuote;
  let hash: string;
  if (route.from_token.chainId === BridgeChain.SUI) {
    if (!walletConnection.sui) {
      throw new Error("Sui wallet connection not found");
    }
    const client = walletConnection.sui.provider;
    // `@mayanfinance/swap-sdk` is built against `@mysten/sui@^1.x`. Cast to
    // `any` at the boundary; runtime reads will work as long as Mayan's
    // calls map to v1 methods that v2's gRPC client exposes (e.g. it uses
    // `client.devInspectTransactionBlock` / `getObject` — both of which
    // have v2 equivalents reachable via the same top-level methods on
    // `SuiGrpcClient` for backwards compat). If Mayan adds a v1-only call
    // in a future release, this cast will need a vendor-and-patch like
    // `src/libs/PythClient.ts`.
    const swapTrx = await createSwapFromSuiMoveCalls(
      mayanQuote,
      fromAddress,
      toAddress,
      referrerAddresses,
      null,
      client as any
    );
    const connection = walletConnection.sui;
    // `swapTrx` comes from `@mayanfinance/swap-sdk`, which bundles its own
    // copy of `@mysten/sui@1.x`. The Transaction class identity differs
    // from our v2 Transaction even though the on-the-wire BCS bytes are
    // identical, so we cast to `any` to bridge the two SDKs.
    const signed: {
      bytes: string;
      signature: string;
    } = await connection.signTransaction({ transaction: swapTrx as any });
    // v2 `core.executeTransaction` accepts `transaction: Uint8Array` (the
    // built bytes) + `signatures: string[]`; the result envelope is
    // `{ Transaction } | { FailedTransaction }`. We unwrap to read the
    // digest. Pre-fork the v1 `executeTransactionBlock` returned the
    // digest flat at `resp.digest`.
    const txBytes = typeof signed.bytes === "string"
      ? Uint8Array.from(Buffer.from(signed.bytes, "base64"))
      : signed.bytes;
    const resp = await client.core.executeTransaction({
      transaction: txBytes,
      signatures: [signed.signature],
      include: { effects: true, events: true, balanceChanges: true },
    });
    const submitted = resp.Transaction ?? resp.FailedTransaction;
    if (!submitted) {
      throw new Error("Mayan bridge: executeTransaction returned no transaction envelope");
    }
    hash = submitted.digest;
    await client.core.waitForTransaction({ digest: hash });
  } else if (route.from_token.chainId === BridgeChain.SOLANA) {
    if (!walletConnection.solana) {
      throw new Error("Solana wallet connection not found");
    }
    const connection = walletConnection.solana;
    const swapTrx = await swapFromSolana(
      mayanQuote,
      fromAddress,
      toAddress,
      referrerAddresses,
      connection.signTransaction,
      connection.connection,
      connection.extraRpcs,
      connection.sendOptions,
      connection.jitoOptions
    );
    hash = swapTrx.signature;
  } else {
    if (!walletConnection.evm) {
      throw new Error("EVM wallet connection not found");
    }
    const connection = walletConnection.evm;
    const fromToken = mayanQuote.fromToken;
    if (fromToken.standard === "erc20") {
      const erc20Contract = new Contract(
        fromToken.realOriginContractAddress || fromToken.contract,
        ERC20_ABI,
        connection.signer
      );
      const currentAllowance = await erc20Contract.allowance(
        fromAddress,
        addresses.MAYAN_FORWARDER_CONTRACT
      );
      const REQUIRED_ALLOWANCE = parseUnits(
        String(mayanQuote.effectiveAmountIn),
        fromToken.decimals
      );
      if (currentAllowance < REQUIRED_ALLOWANCE) {
        const approveTrx = await erc20Contract.approve(
          addresses.MAYAN_FORWARDER_CONTRACT,
          REQUIRED_ALLOWANCE
        );
        const receiptApprove = await approveTrx.wait();
        if (!receiptApprove) {
          throw new Error("Failed to approve allowance");
        }
      }
    }
    const swapTrx = await swapFromEvm(
      mayanQuote,
      fromAddress,
      toAddress,
      referrerAddresses,
      connection.signer,
      connection.permit,
      connection.overrides,
      null
    );
    hash = typeof swapTrx === "string" ? swapTrx : swapTrx.hash;
    await connection.waitForTransaction({
      hash,
      confirmations: 3,
    });
  }
  // wait for 2 seconds to make sure the mayan has processed the transaction
  await new Promise((resolve) => {
    setTimeout(() => {
      resolve(true);
    }, 2000);
  });
  return hash;
}
