// ---------------------------------------------------------------------------
// gRPC URL helper for AccountManager.
//
// Pre-fork the SDK shipped a `NAVIHttpTransport` class that wrapped axios
// around the JSON-RPC envelope, which let users pass a custom RPC endpoint
// to `new AccountManager({ network: '<custom-url>' })`. v2 of `@mysten/sui`
// stops shipping the JSON-RPC client by default — gRPC is the new default
// transport — and `SuiGrpcClient`'s `baseUrl` constructor option already
// covers the "custom endpoint" use case the transport class was added for.
// So we drop the class and expose a single resolver here.
// ---------------------------------------------------------------------------

import type { SuiClientTypes } from "@mysten/sui/client";

export type NaviNetwork = SuiClientTypes.Network;

const FULLNODE_BASE_URLS: Record<string, string> = {
  mainnet: "https://fullnode.mainnet.sui.io:443",
  testnet: "https://fullnode.testnet.sui.io:443",
  devnet: "https://fullnode.devnet.sui.io:443",
  localnet: "http://127.0.0.1:9000",
};

/**
 * Resolve a `network` string into `(network, baseUrl)` for `SuiGrpcClient`.
 * Accepts either a known network name (`mainnet` / `testnet` / `devnet` /
 * `localnet`) or a fully-qualified URL — anything that doesn't look like a
 * known name is treated as a custom mainnet endpoint, matching v1
 * AccountManager's behavior of letting users plug in their own RPC URL.
 */
export function resolveGrpcEndpoint(network: string | undefined): {
  network: NaviNetwork;
  baseUrl: string;
} {
  if (!network) {
    return { network: "mainnet", baseUrl: FULLNODE_BASE_URLS.mainnet };
  }
  if (network in FULLNODE_BASE_URLS) {
    return {
      network: network as NaviNetwork,
      baseUrl: FULLNODE_BASE_URLS[network],
    };
  }
  // Treat as a custom URL — the caller has supplied their own fullnode
  // endpoint. v1 used this path with NAVIHttpTransport; v2 plumbs it
  // straight into `SuiGrpcClient.baseUrl`.
  return { network: "mainnet", baseUrl: network };
}
