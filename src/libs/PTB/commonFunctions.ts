import { Transaction } from "@mysten/sui/transactions";
import { getConfig, flashloanConfig, pool, vSuiConfig, PriceFeedConfig, OracleProConfig, IPriceFeed, AddressMap } from '../../address'
import { CoinInfo, Pool, PoolConfig, OptionType, PoolRewards } from '../../types';
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { HermesClient } from '@pythnetwork/hermes-client';
import { SuiPythClient } from '../PythClient';
import { Buffer } from 'node:buffer';

// `registerStructs()` was the only consumer of `bcs` in this file; v2 typed
// struct defs now live in `src/libs/bcs.ts`. Import retained at zero use here.
import * as V3 from  './V3';
import * as V2 from  './V2';


/**
 * Deposits a specified amount of a coin into a pool.
 * @param txb - The transaction block object.
 * @param _pool - The pool configuration object.
 * @param coinObject - The object representing the coin you own.
 * @param amount - The amount of the coin to deposit.
 * @returns The updated transaction block object.
 */
export async function depositCoin(txb: Transaction, _pool: PoolConfig, coinObject: any, amount: any) {
    const config = await getConfig();

    let amountObj;
    if (typeof amount === 'number') {
        amountObj = txb.pure.u64(amount);
    }
    else {
        amountObj = amount;
    }
    txb.moveCall({
        target: `${config.ProtocolPackage}::incentive_v3::entry_deposit`,
        arguments: [
            txb.object('0x06'), // clock object id
            txb.object(config.StorageId), // object id of storage
            txb.object(_pool.poolId), // pool id of the asset
            txb.pure.u8(_pool.assetId), // the id of the asset in the protocol
            coinObject, // the object id of the Coin you own.
            amountObj, // The amount you want to deposit, decimals must be carried, like 1 sui => 1000000000
            txb.object(config.IncentiveV2),
            txb.object(config.IncentiveV3), // The incentive object v3
        ],
        typeArguments: [_pool.type]
    })
    return txb;
}

/**
 * Deposits a coin with account cap.
 * @param txb - The transaction block object.
 * @param _pool - The pool configuration object.
 * @param coinObject - The object representing the coin you own.
 * @param account - The account to deposit the coin into.
 * @returns The updated transaction block object.
 */
export async function depositCoinWithAccountCap(txb: Transaction, _pool: PoolConfig, coinObject: any, account: string) {
    const config = await getConfig();

    txb.moveCall({
        target: `${config.ProtocolPackage}::incentive_v3::deposit_with_account_cap`,
        arguments: [
            txb.object('0x06'), // clock object id
            txb.object(config.StorageId), // object id of storage
            txb.object(_pool.poolId), // pool id of the asset
            txb.pure.u8(_pool.assetId), // the id of the asset in the protocol
            coinObject, // the object id of the Coin you own.
            txb.object(config.IncentiveV2),
            txb.object(config.IncentiveV3), // The incentive object v3
            txb.object(account)
        ],
        typeArguments: [_pool.type]
    })
    return txb;
}

/**
 * Withdraws a specified amount of coins from a pool.
 * 
 * @param txb - The transaction block object.
 * @param _pool - The pool configuration object.
 * @param amount - The amount of coins to withdraw.
 * @returns The updated transaction block object.
 */
export async function withdrawCoin(txb: Transaction, _pool: PoolConfig, amount: number) {
    const config = await getConfig();

    const [ret] = txb.moveCall({
        target: `${config.ProtocolPackage}::incentive_v3::withdraw_v2`,
        arguments: [
            txb.object('0x06'), // clock object id
            txb.object(config.PriceOracle), // object id of oracle
            txb.object(config.StorageId), // object id of storage
            txb.object(_pool.poolId), // pool id of the asset
            txb.pure.u8(_pool.assetId), // the id of the asset in the protocol
            txb.pure.u64(amount), // The amount you want to withdraw, decimals must be carried, like 1 sui => 1000000000
            txb.object(config.IncentiveV2),
            txb.object(config.IncentiveV3), // The incentive object v3
            txb.object('0x05')
        ],
        typeArguments: [_pool.type]
    })

    //Transfer withdraw
    const [coin] = txb.moveCall({
        target: `0x2::coin::from_balance`,
        arguments: [ret],
        typeArguments: [_pool.type]
    });

    return [coin];
}

/**
 * Withdraws a specified amount of coins from an account with an account cap.
 * @param txb - The Transaction object.
 * @param _pool - The PoolConfig object.
 * @param account - The account from which to withdraw the coins.
 * @param withdrawAmount - The amount of coins to withdraw.
 * @param sender - The sender of the transaction.
 */
export async function withdrawCoinWithAccountCap(txb: Transaction, _pool: PoolConfig, account: string, withdrawAmount: number, sender: string) {
    const config = await getConfig();

    const [ret] = txb.moveCall({
        target: `${config.ProtocolPackage}::incentive_v3::withdraw_with_account_cap_v2`,
        arguments: [
            txb.sharedObjectRef({
                objectId: '0x06',
                initialSharedVersion: 1,
                mutable: false,
            }), // clock object id
            txb.object(config.PriceOracle), // object id of oracle
            txb.object(config.StorageId), // object id of storage
            txb.object(_pool.poolId), // pool id of the asset
            txb.pure.u8(_pool.assetId), // the id of the asset in the protocol
            txb.pure.u64(withdrawAmount), // The amount you want to withdraw, decimals must be carried, like 1 sui => 1000000000
            txb.object(config.IncentiveV2),
            txb.object(config.IncentiveV3), // The incentive object v3
            txb.object(account),
            txb.object('0x05')
        ],
        typeArguments: [_pool.type]
    });

    // const [ret] = txb.moveCall({ target: `${config.ProtocolPackage}::lending::create_account` });
    const [coin] = txb.moveCall({
        target: `0x2::coin::from_balance`,
        arguments: [txb.object(ret)],
        typeArguments: [_pool.type]
    });

    return [coin];
}

/**
 * Borrows a specified amount of coins from a pool.
 * @param txb - The transaction block object.
 * @param _pool - The pool configuration object.
 * @param borrowAmount - The amount of coins to borrow.
 * @returns The updated transaction block object.
 */
export async function borrowCoin(txb: Transaction, _pool: PoolConfig, borrowAmount: number) {
    const config = await getConfig();

    const [ret] = txb.moveCall({
        target: `${config.ProtocolPackage}::incentive_v3::borrow_v2`,
        arguments: [
            txb.object('0x06'), // clock object id
            txb.object(config.PriceOracle), // object id of oracle
            txb.object(config.StorageId), // object id of storage
            txb.object(_pool.poolId), // pool id of the asset
            txb.pure.u8(_pool.assetId), // the id of the asset in the protocol
            txb.pure.u64(borrowAmount), // The amount you want to borrow, decimals must be carried, like 1 sui => 1000000000
            txb.object(config.IncentiveV2), // The incentive object v2
            txb.object(config.IncentiveV3), // The incentive object v3
            txb.object('0x05')
        ],
        typeArguments: [_pool.type]
    })

    const [coin] = txb.moveCall({
        target: `0x2::coin::from_balance`,
        arguments: [txb.object(ret)],
        typeArguments: [_pool.type]
    });

    return [coin];

}

/**
 * Repays a debt in the protocol.
 * @param txb - The transaction block object.
 * @param _pool - The pool configuration object.
 * @param coinObject - The object representing the Coin you own.
 * @param repayAmount - The amount you want to repay.
 * @returns The updated transaction block object.
 */
export async function repayDebt(txb: Transaction, _pool: PoolConfig, coinObject: any, repayAmount: any) {
    const config = await getConfig();
    let amountObj;
    if (typeof repayAmount === 'number') {
        amountObj = txb.pure.u64(repayAmount);
    }
    else {
        amountObj = repayAmount;
    }

    txb.moveCall({
        target: `${config.ProtocolPackage}::incentive_v3::entry_repay`,
        arguments: [
            txb.object('0x06'), // clock object id
            txb.object(config.PriceOracle), // object id of oracle
            txb.object(config.StorageId), // object id of storage
            txb.object(_pool.poolId), // pool id of the asset
            txb.pure.u8(_pool.assetId), // the id of the asset in the protocol
            coinObject, // the object id of the Coin you own.
            amountObj, // The amount you want to borrow, decimals must be carried, like 1 sui => 1000000000
            txb.object(config.IncentiveV2), // The incentive object v2 
            txb.object(config.IncentiveV3), // The incentive object v3
        ],
        typeArguments: [_pool.type]
    })
    return txb;

}

/**
 * Retrieves the health factor for a given address.
 * @param txb - The Transaction object.
 * @param address - The address for which to retrieve the health factor.
 * @returns The health factor balance.
 */
export async function getHealthFactorPTB(txb: Transaction, address: string) {
    const config = await getConfig();

    const balance = txb.moveCall({
        target: `${config.uiGetter}::logic_getter_unchecked::user_health_factor`,
        arguments: [
            txb.object('0x06'), // clock object id
            txb.object(config.StorageId), // object id of storage
            txb.object(config.PriceOracle), // Object id of Price Oracle
            txb.pure.address(address)
        ],

    })

    return balance;
}

/**
 * Merges multiple coins into a single coin object.
 * 
 * @param txb - The transaction block object.
 * @param coinInfo - The coin information object.
 * @returns The merged coin object.
 */
export function returnMergedCoins(txb: Transaction, coinInfo: any) {

    if (coinInfo.data.length >= 2) {
        let baseObj = coinInfo.data[0].coinObjectId;
        let all_list = coinInfo.data.slice(1).map((coin: any) => coin.coinObjectId);

        txb.mergeCoins(baseObj, all_list);
    }

    let mergedCoinObject = txb.object(coinInfo.data[0].coinObjectId);
    return mergedCoinObject;
}


/**
 * Executes a flash loan transaction.
 * @param txb - The Transaction object.
 * @param _pool - The PoolConfig object representing the pool.
 * @param amount - The amount of the flash loan.
 * @returns An array containing the balance and receipt of the flash loan transaction.
 */
export async function flashloan(txb: Transaction, _pool: PoolConfig, amount: number) {
    const config = await getConfig();

    const [balance, receipt] = txb.moveCall({
        target: `${config.ProtocolPackage}::lending::flash_loan_with_ctx_v2`,
        arguments: [
            txb.object(flashloanConfig.id), // clock object id
            txb.object(_pool.poolId), // pool id of the asset
            txb.pure.u64(amount), // the id of the asset in the protocol
            txb.object('0x05')
        ],
        typeArguments: [_pool.type]
    })
    return [balance, receipt];
}

/**
 * Repays a flash loan by calling the flash_repay_with_ctx function in the lending protocol.
 * 
 * @param txb - The Transaction object.
 * @param _pool - The PoolConfig object representing the pool.
 * @param receipt - The receipt object.
 * @param repayCoin - The asset ID of the asset to be repaid.
 * @returns The balance after the flash loan is repaid.
 */
export async function repayFlashLoan(txb: Transaction, _pool: PoolConfig, receipt: any, repayCoin: any) {
    const config = await getConfig();

    const [balance] = txb.moveCall({
        target: `${config.ProtocolPackage}::lending::flash_repay_with_ctx`,
        arguments: [
            txb.object('0x06'), // clock object id
            txb.object(config.StorageId),
            txb.object(_pool.poolId), // pool id of the asset
            receipt,
            repayCoin, // the id of the asset in the protocol
        ],
        typeArguments: [_pool.type]
    })
    return [balance];
}


/**
 * Liquidates a transaction block.
 * @param txb - The transaction block to be liquidated.
 * @param payCoinType - The type of coin to be paid.
 * @param payCoinObj - The payment coin object.
 * @param collateralCoinType - The type of collateral coin.
 * @param to_liquidate_address - The address to which the liquidated amount will be sent.
 * @param to_liquidate_amount - The amount to be liquidated.
 * @returns An array containing the collateral coin and the remaining debt coin.
 */
export async function liquidateFunction(txb: Transaction, payCoinType: CoinInfo, payCoinObj: any, collateralCoinType: CoinInfo, to_liquidate_address: string, to_liquidate_amount: string) {
    const pool_to_pay: PoolConfig = pool[payCoinType.symbol as keyof Pool];
    const collateral_pool: PoolConfig = pool[collateralCoinType.symbol as keyof Pool];
    const config = await getConfig();

    const [collateralBalance, remainDebtBalance] = txb.moveCall({
        target: `${config.ProtocolPackage}::incentive_v3::liquidation_v2`,
        arguments: [
            txb.object('0x06'),
            txb.object(config.PriceOracle),
            txb.object(config.StorageId),
            txb.pure.u8(pool_to_pay.assetId),
            txb.object(pool_to_pay.poolId),
            payCoinObj,
            txb.pure.u8(collateral_pool.assetId),
            txb.object(collateral_pool.poolId),
            txb.pure.address(to_liquidate_address),
            txb.object(config.IncentiveV2),
            txb.object(config.IncentiveV3),
            txb.object('0x05')
        ],
        typeArguments: [pool_to_pay.type, collateral_pool.type],
    })

    return [collateralBalance, remainDebtBalance];
}


/**
 * Signs and submits a transaction block using the provided client and keypair.
 *
 * v2 Core API: `client.core.signAndExecuteTransaction` accepts `transaction`
 * (a Transaction object or pre-built Uint8Array), a `signer`, and `include`
 * to ask for effects/events back. The v1 `requestType: 'WaitForLocalExecution'`
 * option has no v2 equivalent — finality is observed via
 * `client.core.waitForTransaction` (called separately if the caller wants).
 * Result envelope is `{ Transaction } | { FailedTransaction }`; we unwrap so
 * callers see a flat `Transaction` regardless of success.
 */
export async function SignAndSubmitTXB(txb: Transaction, client: ClientWithCoreApi, keypair: any) {
    const result = await client.core.signAndExecuteTransaction({
        transaction: txb,
        signer: keypair,
        include: { effects: true },
    });
    return result.Transaction ?? result.FailedTransaction;
}


/**
 * Stakes a given SUI coin object to the vSUI pool.
 * @param txb The transaction block object.
 * @param suiCoinObj The SUI coin object to be staked.
 * @returns vSui coin object.
 */
export async function stakeTovSuiPTB(txb: Transaction, suiCoinObj: any) {

    const [coin] = txb.moveCall({
        target: `${vSuiConfig.ProtocolPackage}::stake_pool::stake`,
        arguments: [
            txb.object(vSuiConfig.pool),
            txb.object(vSuiConfig.metadata),
            txb.object(vSuiConfig.wrapper),
            suiCoinObj,
        ],
        typeArguments: [],
    })
    return coin;
}

/**
 * Unstakes TOV SUI coins.
 * @param txb - The transaction block object.
 * @param vSuiCoinObj - The vSui coin object.
 * @returns The unstaked Sui coin.
 */
export async function unstakeTovSui(txb: Transaction, vSuiCoinObj: any) {

    const [coin] = txb.moveCall({
        target: `${vSuiConfig.ProtocolPackage}::stake_pool::unstake`,
        arguments: [
            txb.object(vSuiConfig.pool),
            txb.object(vSuiConfig.metadata),
            txb.object(vSuiConfig.wrapper),
            vSuiCoinObj,
        ],
        typeArguments: [],
    })
    return coin;
}


/**
 * Retrieves available rewards for the given address.
 *
 * @param client - Sui client instance.
 * @param checkAddress - The address for which rewards are being checked.
 * @param contractOptionTypes - Array of contract option types to filter rewards (e.g., [1], [3], or [1,3]).
 *                              When passing [1], only supply rewards will be returned.
 *                              When passing [3], only borrow rewards will be returned.
 *                              When passing [1,3], rewards for both options will be returned.
 * @param prettyPrint - Flag to determine if the result should be pretty printed.
 * @param includeV2 - Feature flag to enable/disable V2 logic.
 * @returns Promise resolving to an array of aggregated PoolRewards.
 */
export async function getAvailableRewards(
    client: ClientWithCoreApi,
    checkAddress: string,
    contractOptionTypes: OptionType[], // Use ContractOptionType[] if you have a dedicated type
    prettyPrint = true,
    includeV2: boolean = false // Feature flag to enable/disable V2 logic
  ): Promise<PoolRewards[]> {
    // Concurrently fetch rewards data for V2 (option 1 and/or 3) and V3.
    const v2Promises: Array<Promise<Record<string, any> | null>> = [];
  
    // Fetch V2 rewards for option 1 if requested and if V2 is enabled, else resolve to null.
    if (includeV2 && contractOptionTypes.includes(1)) {
      v2Promises.push(V2.getAvailableRewards(client, checkAddress, 1, prettyPrint));
    } else {
      v2Promises.push(Promise.resolve(null));
    }
  
    // Fetch V2 rewards for option 3 if requested and if V2 is enabled, else resolve to null.
    if (includeV2 && contractOptionTypes.includes(3)) {
      v2Promises.push(V2.getAvailableRewards(client, checkAddress, 3, prettyPrint));
    } else {
      v2Promises.push(Promise.resolve(null));
    }
  
    // Fetch V3 rewards data.
    const v3Promise = V3.getAvailableRewards(client, checkAddress, prettyPrint);
  
    const [v2DataOpt1, v2DataOpt3, v3Data] = await Promise.all([
      v2Promises[0],
      v2Promises[1],
      v3Promise
    ]);
  
    // Type definitions for V2 and V3 entries.
    type V2Entry = {
      asset_id: string;
      available: string;
      reward_id: string;
      reward_coin_type: string;
    };
  
    type V3Entry = {
      asset_id: string;
      reward_id: string;
      reward_coin_type: string;
      user_claimable_reward: number;
      option: number;
    };
  
    // Aggregation map; key format: `${assetId}-${rewardType}-${reward_coin_type}`
    const agg = new Map<string, { assetId: number; rewardType: number; coinType: string; total: number }>();
  
    // Process V2 data with the corresponding rewardType (option).
    const processV2Data = (v2Data: Record<string, V2Entry> | null, rewardType: number) => {
      if (!v2Data) return;
      for (const [assetIdKey, entry] of Object.entries(v2Data)) {
        const assetId = parseInt(entry.asset_id, 10); // assetId is taken from the key
        const value = parseFloat(entry.available);
        if (agg.has(assetIdKey)) {
          agg.get(assetIdKey)!.total += value;
        } else {
          agg.set(assetIdKey, { assetId, rewardType, coinType: entry.reward_coin_type, total: value });
        }
      }
    };
    processV2Data(v2DataOpt1, 1);
    processV2Data(v2DataOpt3, 3);
  
    // Process V3 data, filtering based on contractOptionTypes.
    if (v3Data) {
      for (const entries of Object.values(v3Data)) {
        for (const entry of entries as V3Entry[]) {
          // Skip entry if its option is not in the provided contractOptionTypes.
          if (!contractOptionTypes.includes(entry.option)) continue;
          const assetId = parseInt(entry.asset_id, 10);
          const rewardType = entry.option;
          const key = `${assetId}-${rewardType}-${entry.reward_coin_type}`;
          if (agg.has(key)) {
            agg.get(key)!.total += entry.user_claimable_reward;
          } else {
            agg.set(key, { assetId, rewardType, coinType: entry.reward_coin_type, total: entry.user_claimable_reward });
          }
        }
      }
    }
  
    // Group the rewards by assetId and rewardType. The group key is `${assetId}-${rewardType}`.
    const groupMap = new Map<string, { assetId: number; rewardType: number; rewards: Map<string, number> }>();
    for (const { assetId, rewardType, coinType, total } of agg.values()) {
      const groupKey = `${assetId}-${rewardType}`;
      if (!groupMap.has(groupKey)) {
        groupMap.set(groupKey, { assetId, rewardType, rewards: new Map<string, number>() });
      }
      const rewardMap = groupMap.get(groupKey)!;
      rewardMap.rewards.set(coinType, (rewardMap.rewards.get(coinType) || 0) + total);
    }
  
    // Construct the final result array.
    return Array.from(groupMap.values()).map(group => ({
      assetId: group.assetId,
      rewardType: group.rewardType,
      rewards: Array.from(group.rewards.entries()).map(([coinType, available]) => ({
        coinType,
        available: available.toFixed(6),
      })),
    }));
  }

/**
   * Claims all available rewards for the specified account.
   * @returns PTB result
   */
export async function claimAllRewardsPTB(client: ClientWithCoreApi, userToCheck: string, existingTx?: Transaction) {
    let tx = existingTx || new Transaction();
    // await V2.claimAllRewardsPTB(client, userToCheck, tx)
    await V3.claimAllRewardsPTB(client, userToCheck, tx)

    return tx
}

/**
   * Claims available rewards by asset ID for the specified account.
   * @returns PTB result
   */
export async function claimRewardsByAssetIdPTB(client: ClientWithCoreApi, userToCheck: string, assetId: number, existingTx?: Transaction) {
    let tx = existingTx || new Transaction();
    // await V2.claimRewardsByAssetIdPTB(client, userToCheck, assetId, tx)
    await V3.claimRewardsByAssetIdPTB(client, userToCheck, assetId, tx)

    return tx
}


/**
   * Claims all available rewards for the specified account.
   * @returns PTB result
   */
export async function claimAllRewardsResupplyPTB(client: ClientWithCoreApi, userToCheck: string, existingTx?: Transaction) {
    let tx = existingTx || new Transaction();
    // await V2.claimAllRewardsResupplyPTB(client, userToCheck, tx)
    await V3.claimAllRewardsResupplyPTB(client, userToCheck, tx)

    return tx
}

/**
 * Represents a connection to the SuiPriceService.
 * 
 * @remarks
 * This connection is used to communicate with the SuiPriceService API.
 * 
 * @param url - The URL of the SuiPriceService API.
 * @param options - Optional configuration options for the connection.
 * @returns A new instance of the SuiPriceServiceConnection.
 */
// Pre-fork the SDK used `SuiPriceServiceConnection` from `@pythnetwork/pyth-sui-js`
// which transitively required `@mysten/sui@^1.x`. v3 of Pyth split the
// HTTP-only API client into the standalone `@pythnetwork/hermes-client`
// package — same Hermes endpoint, no Sui SDK dependency.
const hermesClient = new HermesClient('https://hermes.pyth.network', { timeout: 20000 } as any);

/**
 * Retrieves the stale price feed IDs from the given array of price IDs.
 *
 * @param priceIds - An array of price IDs.
 * @returns A promise that resolves to an array of stale price feed IDs.
 * @throws If there is an error while retrieving the stale price feed IDs.
 */
async function getPythStalePriceFeedId(priceIds: string[]): Promise<string[]> {
    try {
        const returnData: string[] = [];
        const update = await hermesClient.getLatestPriceUpdates(priceIds, { parsed: true });
        const parsed = update?.parsed ?? [];
        if (parsed.length === 0) return returnData;

        const currentTimestamp = Math.floor(new Date().valueOf() / 1000);
        for (const feed of parsed) {
            const id = String((feed as any).id);
            const publishTime = Number((feed as any).price?.publish_time ?? 0);
            if (publishTime > currentTimestamp) {
                console.warn(
                    `pyth price feed is invalid, id: ${id}, publish time: ${publishTime}, current timestamp: ${currentTimestamp}`,
                );
                continue;
            }
            // Pyth state default staleness is 60s; we tighten to 30s to give the
            // PTB extra headroom under variable network latency.
            if (currentTimestamp - publishTime > 30) {
                console.info(
                    `stale price feed, id: ${id}, publish time: ${publishTime}, current timestamp: ${currentTimestamp}`,
                );
                returnData.push(id);
            }
        }
        return returnData;
    } catch (error) {
        throw new Error(`failed to get pyth stale price feed id, msg: ${(error as Error).message}`);
    }
}

/**
 * Updates the single price in the transaction.
 * 
 * @param txb - The transaction object.
 * @param input - The input object containing the feedId and pythPriceInfoObject.
 */
function updateSinglePrice(txb: Transaction, input: Pick<IPriceFeed, 'feedId' | 'pythPriceInfoObject'>) {
    txb.moveCall({
        target: `${OracleProConfig.PackageId}::oracle_pro::update_single_price`,
        arguments: [
            txb.object('0x6'),
            txb.object(OracleProConfig.OracleConfig),
            txb.object(OracleProConfig.PriceOracle),
            txb.object(OracleProConfig.SupraOracleHolder),
            txb.object(input.pythPriceInfoObject),
            txb.pure.address(input.feedId),
        ],
    })
}

/**
 * Updates the Pyth price feeds.
 * 
 * @param client - The SuiClient object.
 * @param txb - The Transaction object.
 * @param priceFeedIds - An array of price feed IDs.
 * @returns A Promise that resolves to the result of updating the price feeds.
 * @throws If there is an error updating the price feeds.
 */
// Fetches the binary VAA update messages from Hermes and returns them as
// Buffers in the order Pyth's `update_price_feeds` Move call expects.
async function fetchPythUpdateBuffers(priceIds: string[]): Promise<Buffer[]> {
    const update = await hermesClient.getLatestPriceUpdates(priceIds, { encoding: 'hex' });
    const binaryData = (update?.binary?.data ?? []) as string[];
    return binaryData.map((hex) => Buffer.from(hex, 'hex'));
}

async function updatePythPriceFeeds(client: ClientWithCoreApi, txb: Transaction, priceFeedIds: string[]) {
    try {
        const priceUpdateData = await fetchPythUpdateBuffers(priceFeedIds);
        const suiPythClient = new SuiPythClient(client, OracleProConfig.PythStateId, OracleProConfig.WormholeStateId);
        return await suiPythClient.updatePriceFeeds(txb, priceUpdateData, priceFeedIds);
    } catch (error) {
        throw new Error(`failed to update pyth price feeds, msg: ${(error as Error).message}`);
    }
}

/**
 * Updates the price of the given transaction using the provided client.
 * 
 * @param client - The SuiClient used to update the price.
 * @param txb - The Transaction to update the price for.
 * @returns A Promise that resolves once the price has been updated.
 */
export async function updateOraclePTB(client: ClientWithCoreApi, txb: Transaction) {
    const pythPriceFeedIds = Object.keys(PriceFeedConfig).map((key) => PriceFeedConfig[key].pythPriceFeedId)
    const stalePriceFeedIds = await getPythStalePriceFeedId(pythPriceFeedIds)
    if (stalePriceFeedIds.length > 0) {
        await updatePythPriceFeeds(client, txb, stalePriceFeedIds)
        console.info(`request update pyth price feed, ids: ${stalePriceFeedIds}`)
    }
    updateSinglePrice(txb, PriceFeedConfig.SUI)
    updateSinglePrice(txb, PriceFeedConfig.WUSDC)
    updateSinglePrice(txb, PriceFeedConfig.USDT)
    updateSinglePrice(txb, PriceFeedConfig.WETH)
    updateSinglePrice(txb, PriceFeedConfig.CETUS)
    updateSinglePrice(txb, PriceFeedConfig.CERT)
    updateSinglePrice(txb, PriceFeedConfig.HASUI)
    updateSinglePrice(txb, PriceFeedConfig.NAVX)
    updateSinglePrice(txb, PriceFeedConfig.WBTC)
    updateSinglePrice(txb, PriceFeedConfig.AUSD)
    updateSinglePrice(txb, PriceFeedConfig.NUSDC)
    updateSinglePrice(txb, PriceFeedConfig.ETH)
    updateSinglePrice(txb, PriceFeedConfig.USDY)
    updateSinglePrice(txb, PriceFeedConfig.NS)
    updateSinglePrice(txb, PriceFeedConfig.LORENZOBTC)
    updateSinglePrice(txb, PriceFeedConfig.DEEP)
    updateSinglePrice(txb, PriceFeedConfig.FDUSD)
    updateSinglePrice(txb, PriceFeedConfig.BLUE)
    updateSinglePrice(txb, PriceFeedConfig.BUCK)
    updateSinglePrice(txb, PriceFeedConfig.SUIUSDT)
    updateSinglePrice(txb, PriceFeedConfig.STSUI);
    updateSinglePrice(txb, PriceFeedConfig.SUIBTC);
    updateSinglePrice(txb, PriceFeedConfig.WSOL);
    updateSinglePrice(txb, PriceFeedConfig.LBTC);
    updateSinglePrice(txb, PriceFeedConfig.WAL);
    updateSinglePrice(txb, PriceFeedConfig.HAEDAL);
    updateSinglePrice(txb, PriceFeedConfig.XBTC);
    updateSinglePrice(txb, PriceFeedConfig.IKA);
    updateSinglePrice(txb, PriceFeedConfig.EnzoBTC);
    updateSinglePrice(txb, PriceFeedConfig.MBTC);
    updateSinglePrice(txb, PriceFeedConfig.YBTC);
    updateSinglePrice(txb, PriceFeedConfig.XAUM);
}

export async function updateOracleByIdsPTB(client: ClientWithCoreApi, txb: Transaction, oracleIds: number[]) {
    const matchedConfigs = Object.values(PriceFeedConfig).filter((cfg) =>
        oracleIds.includes(cfg.oracleId)
    );
    const pythPriceFeedIds = Array.from(
        new Set(matchedConfigs.map((item) => item.pythPriceFeedId))
    );
    const stalePriceFeedIds = await getPythStalePriceFeedId(pythPriceFeedIds)
    if (stalePriceFeedIds.length > 0) {
        await updatePythPriceFeeds(client, txb, stalePriceFeedIds)
        console.info(`request update pyth price feed, ids: ${stalePriceFeedIds}`)
    }

    for (const config of matchedConfigs) {
        updateSinglePrice(txb, config);
    }
}


/**
 * No-op registration shim. Pre-fork this called `bcs.registerStructType` for
 * every Move struct used by `inspectResultParseAndPrint`. v2 `@mysten/sui/bcs`
 * removed the runtime-named registry — every struct is now a typed
 * `BcsType<T>` declared up-front in `src/libs/bcs.ts` and resolved per-callsite
 * via `parseBcsTypeString`. The function is preserved as a no-op so that
 * existing call sites (`registerStructs()` at the start of various readers)
 * keep compiling without forcing every consumer to drop the call in lockstep.
 */
export function registerStructs() {
    /* intentionally empty — see src/libs/bcs.ts for the v2 typed struct definitions */
}
