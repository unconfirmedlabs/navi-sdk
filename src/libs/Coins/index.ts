import type { ClientWithCoreApi } from "@mysten/sui/client";

/**
 * Retrieves the amount of a specific coin owned by a sender.
 *
 * v2 `core.getBalance` returns `{ balance: { coinType, balance, ... } }`
 * (was v1 `{ totalBalance, coinObjectCount }`).
 */
export async function getCoinAmount(
  client: ClientWithCoreApi,
  sender: string,
  coinType: string
): Promise<number> {
  if (!sender) {
    throw new Error("Sender is undefined.");
  }
  if (!client) {
    throw new Error("Client is undefined.");
  }
  const coinInfo = await client.core.getBalance({
    owner: sender,
    coinType,
  });
  const tokenBalance = Number(coinInfo.balance.balance);
  console.log("Token Type : ", coinType, "Balance: ", tokenBalance);
  return tokenBalance;
}

/**
 * Retrieves the decimal value for a specific coin type.
 * v2 `core.getCoinMetadata` wraps the response as `{ coinMetadata: ... | null }`.
 */
export async function getCoinDecimal(
  client: ClientWithCoreApi,
  coinType: string
): Promise<any> {
  const result = await client.core.getCoinMetadata({ coinType });
  if (result.coinMetadata) return result.coinMetadata.decimals;
  return 9;
}
