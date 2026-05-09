import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import type { SuiClientTypes } from "@mysten/sui/client";
import { initializeParams, SwapOptions } from "../../types";
import { getCoinAmount, getCoinDecimal } from "../Coins";
import { Transaction } from "@mysten/sui/transactions";
import { getConfig, pool, AddressMap, vSui } from "../../address";
import { Pool, PoolConfig, CoinInfo } from "../../types";
import {
  depositCoin,
  depositCoinWithAccountCap,
  returnMergedCoins,
  withdrawCoin,
  withdrawCoinWithAccountCap,
  borrowCoin,
  repayDebt,
  liquidateFunction,
  SignAndSubmitTXB,
  stakeTovSuiPTB,
  unstakeTovSui,
  claimAllRewardsPTB,
  updateOraclePTB,
  swapPTB,
  getCoinPTB,
} from "../PTB";
import { getAddressPortfolio, getHealthFactorCall, getReservesDetail, moveInspect } from "../CallFunctions";
import assert from 'assert';
import { registerStructs } from '../PTB';
import { resolveGrpcEndpoint } from "./rpc";

// ---------------------------------------------------------------------------
// AccountManager — v2 gRPC migration.
//
// Pre-fork the SDK constructed a JSON-RPC `SuiClient` from `@mysten/sui/client`
// (v1.16). Sui's JSON-RPC interface is deprecated and shuts off June 2026, so
// this fork uses `SuiGrpcClient` from `@mysten/sui/grpc` (v2.x). On-chain
// behaviour is identical — every Move-call/PTB byte produced is the same
// regardless of read transport — but the off-chain TypeScript surface
// follows the v2 Core API:
//   - reads route through `client.core.*`
//   - response shapes use the v2 contracts (`{ balance: { balance } }`,
//     `{ objects, cursor, hasNextPage }`, flat `Coin.objectId`, etc.)
//   - dry-runs use `core.simulateTransaction` (returns the discriminated
//     `{ Transaction } | { FailedTransaction }` envelope)
// ---------------------------------------------------------------------------

export class AccountManager {
  public keypair: Ed25519Keypair;
  public client: SuiGrpcClient;
  public address: string = "";

  /**
   * AccountManager class for managing user accounts.
   *
   * `network` accepts a known network name (`mainnet` / `testnet` / `devnet` /
   * `localnet`) or a custom fullnode `baseUrl` (e.g. a vendor-keyed endpoint).
   * Anything that isn't a known network name is treated as a custom mainnet
   * URL — same forgiving behaviour the v1 `NAVIHttpTransport` allowed.
   */
  constructor({ mnemonic = "", network = "mainnet", accountIndex = 0, privateKey = "" } = {}) {
    if (privateKey && privateKey !== "") {
      this.keypair = Ed25519Keypair.fromSecretKey(privateKey);
    } else {
      this.keypair = Ed25519Keypair.deriveKeypair(mnemonic, this.getDerivationPath(accountIndex));
    }

    const { network: resolvedNetwork, baseUrl } = resolveGrpcEndpoint(network);
    this.client = new SuiGrpcClient({ network: resolvedNetwork, baseUrl });

    this.address = this.keypair.getPublicKey().toSuiAddress();
    registerStructs();
  }

  /**
   * Returns the derivation path for a given address index.
   *
   * @param addressIndex - The index of the address.
   * @returns The derivation path as a string.
   */
  getDerivationPath(addressIndex: number) {
    return `m/44'/784'/0'/0'/${addressIndex}'`;
  }

  /**
   * Retrieves the public key associated with the account.
   * @returns The public key as a Sui address string.
   */
  getPublicKey() {
    return this.keypair.getPublicKey().toSuiAddress();
  }

  /**
   * Walks every coin object owned by `account` via paginated
   * `core.listOwnedObjects` filtered to `0x2::coin::Coin`. Returns the v2
   * Object shape directly — caller-side code that previously read
   * `coin.coinObjectId` should now read `coin.objectId`.
   *
   * Pre-fork this used `client.getAllCoins` (v1) which returned
   * `CoinStruct[]` shaped with `coinObjectId`. v2 has no `getAllCoins` —
   * the closest filter is `listOwnedObjects({ type: '0x2::coin::Coin' })`
   * which returns objects with metadata; the caller is responsible for
   * extracting `Coin<T>` balance from the v2 `json` payload if needed.
   */
  async fetchAllCoins(
    account: string,
    cursor: string | null = null,
  ): Promise<ReadonlyArray<SuiClientTypes.Object<{ json: true }>>> {
    const { objects, cursor: nextCursor, hasNextPage } = await this.client.core.listOwnedObjects({
      owner: account,
      type: "0x2::coin::Coin",
      cursor,
      include: { json: true },
    });

    if (!hasNextPage) return objects;
    const newData = await this.fetchAllCoins(account, nextCursor);
    return [...objects, ...newData];
  }

  /**
   * Retrieves all the coin objects owned by the account.
   *
   * @param prettyPrint - If true, prints each coin's type and object id. Default true.
   * @returns A Promise that resolves to the v2 Object array of coin objects.
   */
  async getAllCoins(
    prettyPrint: boolean = true,
  ): Promise<ReadonlyArray<SuiClientTypes.Object<{ json: true }>>> {
    const allData = await this.fetchAllCoins(this.address);

    if (prettyPrint) {
      allData.forEach((obj) => {
        const balance = (obj.json as Record<string, unknown> | null)?.balance ?? "0";
        console.log("Coin Type: ", obj.type, "| Obj id: ", obj.objectId, " | Balance: ", balance);
      });
    }

    return allData;
  }

  /**
   * Retrieves the balance of all coins in the wallet via paginated
   * `core.listBalances`. Walks the cursor until exhausted.
   */
  async getWalletBalance(prettyPrint: boolean = true): Promise<Record<string, number>> {
    const allBalances: SuiClientTypes.Balance[] = [];
    let cursor: string | null | undefined = undefined;
    do {
      const page = await this.client.core.listBalances({ owner: this.address, cursor });
      allBalances.push(...page.balances);
      cursor = page.hasNextPage ? page.cursor : null;
    } while (cursor);

    const coinBalances: Record<string, number> = {};
    for (const { coinType, balance } of allBalances) {
      const decimal = await this.getCoinDecimal(coinType);
      coinBalances[coinType] = Number(balance) / Math.pow(10, decimal);
    }

    if (prettyPrint) {
      Object.entries(coinBalances).forEach(([coinType, balanceVal]) => {
        const coinName = AddressMap[coinType] ? `Coin Type: ${AddressMap[coinType]}` : `Unknown Coin Type: ${coinType}`;
        console.log(coinName, "| Balance: ", balanceVal);
      });
    }

    return coinBalances;
  }

  /**
   * Paginated `core.listCoins` walk for a single coin type. Returns the v2
   * Coin shape array — `objectId` (was `coinObjectId`), `balance`, `type`,
   * `version`, `digest`, `owner`.
   */
  async fetchCoins(
    account: string,
    coinType: string,
    cursor: string | null = null,
  ): Promise<ReadonlyArray<SuiClientTypes.Coin>> {
    const { objects, cursor: nextCursor, hasNextPage } = await this.client.core.listCoins({
      owner: account,
      coinType,
      cursor,
    });

    if (!hasNextPage) return objects;
    const newData = await this.fetchCoins(account, coinType, nextCursor);
    return [...objects, ...newData];
  }

  /**
   * Retrieves coin objects of `coinType`. The returned wrapper preserves the
   * pre-fork `{ data: [...] }` envelope shape so internal callers
   * (sendCoinsToMany, depositToNavi, etc.) keep their existing access
   * patterns. Field rename inside: every entry has `objectId` (v2)
   * instead of `coinObjectId` (v1).
   */
  async getCoins(coinType: any = "0x2::sui::SUI"): Promise<{ data: SuiClientTypes.Coin[] }> {
    const coinAddress = coinType.address ? coinType.address : coinType;
    const data = [...(await this.fetchCoins(this.address, coinAddress))];
    return { data };
  }

  /**
   * Creates an account capability.
   * @returns A Promise that resolves to the result of the account creation.
   */
  async createAccountCap() {
    let txb = new Transaction();
    let sender = this.getPublicKey();
    txb.setSender(sender);

    const config = await getConfig();

    const [ret] = txb.moveCall({
      target: `${config.ProtocolPackage}::lending::create_account`,
    });
    txb.transferObjects([ret], this.getPublicKey());
    const result = SignAndSubmitTXB(txb, this.client, this.keypair);
    return result;
  }

  /**
   * Sends coins to multiple recipients.
   *
   * @param coinType - The type of coin to send.
   * @param recipients - An array of recipient addresses.
   * @param amounts - An array of amounts to send to each recipient.
   * @returns A promise that resolves to the result of the transaction.
   * @throws An error if the recipient list contains an empty address string,
   *   or if the length of the recipient array is not equal to the length of
   *   the amounts array, or if there is insufficient balance for the coin.
   */
  async sendCoinsToMany(
    coinType: any,
    recipients: string[],
    amounts: number[],
  ) {
    const coinAddress = coinType.address ? coinType.address : coinType;

    if (recipients.some(address => address.trim() === "")) {
      throw new Error("Recipient list contains an empty address string.");
    }

    if (recipients.length !== amounts.length) {
      throw new Error("recipients.length !== amounts.length");
    }
    let sender = this.getPublicKey();
    const coinBalance = await getCoinAmount(this.client, this.getPublicKey(), coinAddress);

    if (coinBalance > 0 && coinBalance >= amounts.reduce((a, b) => a + b, 0)) {
      const txb = new Transaction();
      txb.setSender(sender);
      let coinInfo = await this.getCoins(coinAddress);
      let coins: any;
      if (coinAddress == "0x2::sui::SUI") {
        coins = txb.splitCoins(txb.gas, amounts);
      } else {
        if (coinInfo.data.length >= 2) {
          let baseObj = coinInfo.data[0].objectId;
          let allList = coinInfo.data.slice(1).map((coin) => coin.objectId);
          txb.mergeCoins(baseObj, allList);
        }
        let mergedCoin = txb.object(coinInfo.data[0].objectId);
        coins = txb.splitCoins(mergedCoin, amounts);
      }
      recipients.forEach((address, index) => {
        txb.transferObjects([coins[index]], address);
      });

      const result = SignAndSubmitTXB(txb, this.client, this.keypair);
      return result;
    } else {
      throw new Error("Insufficient balance for this Coin");
    }
  }

  /**
   * Sends a specified amount of coins to a recipient.
   */
  async sendCoin(coinType: any, recipient: string, amount: number) {
    const coinAddress = coinType.address ? coinType.address : coinType;
    return await this.sendCoinsToMany(coinAddress, [recipient], [amount]);
  }

  /**
   * Transfers multiple objects to multiple recipients.
   * @param objects - An array of object IDs to transfer.
   * @param recipients - An array of recipient addresses.
   */
  async transferObjectsToMany(objects: string[], recipients: string[]) {
    if (objects.length !== recipients.length) {
      throw new Error("The length of objects and recipients should be the same");
    }
    let sender = this.getPublicKey();
    const txb = new Transaction();
    txb.setSender(sender);
    objects.forEach((object, index) => {
      txb.transferObjects([txb.object(object)], recipients[index]);
    });
    const result = SignAndSubmitTXB(txb, this.client, this.keypair);
    return result;
  }

  async transferObject(object: string, recipient: string) {
    return await this.transferObjectsToMany([object], [recipient]);
  }

  /**
   * Deposits a specified amount of a given coin type to Navi.
   */
  async depositToNavi(coinType: CoinInfo, amount: number) {
    const coinSymbol = coinType.symbol;

    let txb = new Transaction();
    let sender = this.getPublicKey();
    txb.setSender(sender);
    const poolConfig: PoolConfig = pool[coinSymbol as keyof Pool];

    let coinInfo = await this.getCoins(coinType.address);
    if (!coinInfo.data[0]) {
      throw new Error("Insufficient balance for this Coin");
    }
    if (coinSymbol == "Sui") {
      const [toDeposit] = txb.splitCoins(txb.gas, [amount]);
      await depositCoin(txb, poolConfig, toDeposit, amount);
    } else {
      const mergedCoinObject = returnMergedCoins(txb, coinInfo);
      const mergedCoinObjectWithAmount = txb.splitCoins(mergedCoinObject, [amount]);
      await depositCoin(txb, poolConfig, mergedCoinObjectWithAmount, amount);
    }
    const result = SignAndSubmitTXB(txb, this.client, this.keypair);
    return result;
  }

  /**
   * Deposits to Navi with an account cap address.
   */
  async depositToNaviWithAccountCap(
    coinType: CoinInfo,
    amount: number,
    accountCapAddress: string,
  ) {
    const coinSymbol = coinType.symbol ? coinType.symbol : coinType;

    let txb = new Transaction();
    let sender = this.getPublicKey();
    txb.setSender(sender);
    const poolConfig: PoolConfig = pool[coinSymbol as keyof Pool];

    let coinInfo = await this.getCoins(coinType.address);
    if (!coinInfo.data[0]) {
      throw new Error("Insufficient balance for this Coin");
    }
    if (coinSymbol == "Sui") {
      const [toDeposit] = txb.splitCoins(txb.gas, [amount]);
      await depositCoinWithAccountCap(txb, poolConfig, toDeposit, accountCapAddress);
    } else {
      const mergedCoinObject = returnMergedCoins(txb, coinInfo);
      const mergedCoinObjectWithAmount = txb.splitCoins(mergedCoinObject, [amount]);
      await depositCoinWithAccountCap(txb, poolConfig, mergedCoinObjectWithAmount, accountCapAddress);
    }
    const result = SignAndSubmitTXB(txb, this.client, this.keypair);
    return result;
  }

  /**
   * Withdraws a specified amount of coins.
   */
  async withdraw(coinType: CoinInfo, amount: number, updateOracle: boolean = true) {
    const coinSymbol = coinType.symbol ? coinType.symbol : coinType;
    let txb = new Transaction();
    if (updateOracle) {
      await updateOraclePTB(this.client, txb);
    }
    let sender = this.getPublicKey();
    txb.setSender(sender);
    const poolConfig: PoolConfig = pool[coinSymbol as keyof Pool];

    const [returnCoin] = await withdrawCoin(txb, poolConfig, amount);
    txb.transferObjects([returnCoin], sender);

    const result = SignAndSubmitTXB(txb, this.client, this.keypair);
    return result;
  }

  /**
   * Withdraws a specified amount of coins with an account cap.
   */
  async withdrawWithAccountCap(
    coinType: CoinInfo,
    withdrawAmount: number,
    accountCapAddress: string,
    updateOracle: boolean = true,
  ) {
    let txb = new Transaction();
    if (updateOracle) {
      await updateOraclePTB(this.client, txb);
    }
    let sender = this.getPublicKey();
    txb.setSender(sender);
    const coinSymbol = coinType.symbol ? coinType.symbol : coinType;
    const poolConfig: PoolConfig = pool[coinSymbol as keyof Pool];
    const [returnCoin] = await withdrawCoinWithAccountCap(
      txb,
      poolConfig,
      accountCapAddress,
      withdrawAmount,
      sender,
    );

    txb.transferObjects([returnCoin], sender);

    const result = SignAndSubmitTXB(txb, this.client, this.keypair);
    return result;
  }

  /**
   * Borrows a specified amount of a given coin.
   */
  async borrow(
    coinType: CoinInfo,
    borrowAmount: number,
    updateOracle: boolean = true,
  ) {
    const coinSymbol = coinType.symbol ? coinType.symbol : coinType;

    let txb = new Transaction();
    if (updateOracle) {
      await updateOraclePTB(this.client, txb);
    }
    let sender = this.getPublicKey();
    txb.setSender(sender);
    const poolConfig: PoolConfig = pool[coinSymbol as keyof Pool];
    const [returnCoin] = await borrowCoin(txb, poolConfig, borrowAmount);
    txb.transferObjects([returnCoin], sender);

    const result = SignAndSubmitTXB(txb, this.client, this.keypair);
    return result;
  }

  /**
   * Repays a specified amount of a given coin type.
   */
  async repay(coinType: CoinInfo, repayAmount: number) {
    const coinSymbol = coinType.symbol ? coinType.symbol : coinType;

    let txb = new Transaction();
    let sender = this.getPublicKey();
    txb.setSender(sender);
    const poolConfig: PoolConfig = pool[coinSymbol as keyof Pool];

    let coinInfo = await this.getCoins(coinType.address);
    if (!coinInfo.data[0]) {
      throw new Error("Insufficient balance for this Coin");
    }
    if (coinSymbol == "Sui") {
      const [toDeposit] = txb.splitCoins(txb.gas, [repayAmount]);
      await repayDebt(txb, poolConfig, toDeposit, repayAmount);
    } else {
      const mergedCoinObject = returnMergedCoins(txb, coinInfo);
      const mergedCoinObjectWithAmount = txb.splitCoins(mergedCoinObject, [repayAmount]);
      await repayDebt(txb, poolConfig, mergedCoinObjectWithAmount, repayAmount);
    }

    const result = SignAndSubmitTXB(txb, this.client, this.keypair);
    return result;
  }

  /**
   * Liquidates a specified amount of coins.
   */
  async liquidate(
    payCoinType: CoinInfo,
    liquidationAddress: string,
    collateralCoinType: CoinInfo,
    liquidationAmount: number = 0,
    updateOracle: boolean = true,
  ) {
    let txb = new Transaction();
    if (updateOracle) {
      await updateOraclePTB(this.client, txb);
    }
    txb.setSender(this.address);

    let coinInfo = await this.getCoins(payCoinType.address);
    // v2 `core.getBalance` returns `{ balance: { coinType, balance, ... } }`
    // (was `{ totalBalance, coinObjectCount }` on v1).
    const allBalance = await this.client.core.getBalance({
      owner: this.address,
      coinType: payCoinType.address,
    });
    let totalBalance = allBalance.balance.balance;
    if (liquidationAmount != 0) {
      assert(
        liquidationAmount * Math.pow(10, payCoinType.decimal) <= Number(totalBalance),
        "Insufficient balance for this Coin, please don't apply decimals to liquidationAmount",
      );
      totalBalance = (liquidationAmount * Math.pow(10, payCoinType.decimal)).toString();
    }

    if (payCoinType.symbol == "Sui") {
      totalBalance = (Number(totalBalance) - 1 * 1e9).toString(); // keep some Sui for gas

      let [mergedCoin] = txb.splitCoins(txb.gas, [txb.pure.u64(Number(totalBalance))]);

      const [mergedCoinBalance] = txb.moveCall({
        target: `0x2::coin::into_balance`,
        arguments: [mergedCoin],
        typeArguments: [payCoinType.address],
      });

      const [collateralBalance, remainingDebtBalance] = await liquidateFunction(
        txb,
        payCoinType,
        mergedCoinBalance,
        collateralCoinType,
        liquidationAddress,
        totalBalance,
      );

      const [collateralCoin] = txb.moveCall({
        target: `0x2::coin::from_balance`,
        arguments: [collateralBalance],
        typeArguments: [collateralCoinType.address],
      });

      const [leftDebtCoin] = txb.moveCall({
        target: `0x2::coin::from_balance`,
        arguments: [remainingDebtBalance],
        typeArguments: [payCoinType.address],
      });

      txb.transferObjects([collateralCoin, leftDebtCoin], this.address);
    } else {
      if (coinInfo.data.length >= 2) {
        const txbMerge = new Transaction();
        txbMerge.setSender(this.address);
        let baseObj = coinInfo.data[0].objectId;
        let allList = coinInfo.data.slice(1).map((coin) => coin.objectId);

        txb.mergeCoins(baseObj, allList);

        SignAndSubmitTXB(txbMerge, this.client, this.keypair);
      }

      let mergedCoin = txb.object(coinInfo.data[0].objectId);
      const [collateralCoinBalance] = txb.moveCall({
        target: `0x2::coin::into_balance`,
        arguments: [mergedCoin],
        typeArguments: [payCoinType.address],
      });
      const [collateralBalance, remainingDebtBalance] = await liquidateFunction(
        txb,
        payCoinType,
        collateralCoinBalance,
        collateralCoinType,
        liquidationAddress,
        totalBalance,
      );

      const [collateralCoin] = txb.moveCall({
        target: `0x2::coin::from_balance`,
        arguments: [collateralBalance],
        typeArguments: [collateralCoinType.address],
      });

      const [leftDebtCoin] = txb.moveCall({
        target: `0x2::coin::from_balance`,
        arguments: [remainingDebtBalance],
        typeArguments: [payCoinType.address],
      });

      txb.transferObjects([collateralCoin, leftDebtCoin], this.address);
    }

    const result = SignAndSubmitTXB(txb, this.client, this.keypair);
    return result;
  }

  /**
   * Retrieves the health factor for a given address.
   */
  async getHealthFactor(address: string = this.address, client?: SuiGrpcClient) {
    const result = await getHealthFactorCall(address, client ? client : this.client);
    const healthFactor = Number(result[0]) / Math.pow(10, 27);
    return healthFactor;
  }

  /**
   * Retrieves the dynamic health factor for a given user in a specific pool.
   */
  async getDynamicHealthFactor(
    userAddress: string,
    coinType: CoinInfo,
    estimatedSupply: number = 0,
    estimatedBorrow: number = 0,
    isIncrease: boolean = true,
  ) {
    const poolConfig: PoolConfig = pool[coinType.symbol as keyof Pool];
    if (!poolConfig) {
      throw new Error("Pool does not exist");
    }
    const config = await getConfig();
    const tx = new Transaction();
    const result: any = await moveInspect(
      tx,
      this.client,
      this.getPublicKey(),
      `${config.ProtocolPackage}::dynamic_calculator::dynamic_health_factor`,
      [
        tx.object('0x06'),
        tx.object(config.StorageId),
        tx.object(config.PriceOracle),
        tx.object(poolConfig.poolId),
        tx.pure.address(userAddress),
        tx.pure.u8(poolConfig.assetId),
        tx.pure.u64(estimatedSupply),
        tx.pure.u64(estimatedBorrow),
        tx.pure.bool(isIncrease),
      ],
      [poolConfig.type],
    );

    const healthFactor = Number(result[0]) / Math.pow(10, 27);

    if (estimatedSupply > 0) {
      console.log('With EstimateSupply Change: ', `${estimatedSupply}`, ' address: ', `${userAddress}`, ' health factor is: ', healthFactor.toString());
    } else if (estimatedBorrow > 0) {
      console.log('With EstimateBorrow Change: ', `${estimatedBorrow}`, ' address: ', `${userAddress}`, ' health factor is: ', healthFactor.toString());
    } else {
      console.log('address: ', `${userAddress}`, ' health factor is: ', healthFactor.toString());
    }
    return healthFactor.toString();
  }

  async getCoinDecimal(coinType: any) {
    const coinAddress = coinType.address ? coinType.address : coinType;
    const decimal = await getCoinDecimal(this.client, coinAddress);
    return decimal;
  }

  parseResult(msg: any) {
    console.log(JSON.stringify(msg, null, 2));
  }

  async getReservesDetail(assetId: number) {
    return getReservesDetail(assetId, this.client);
  }

  async getNAVIPortfolio(
    address: string = this.address,
    prettyPrint: boolean = true,
  ): Promise<Map<string, { borrowBalance: number; supplyBalance: number }>> {
    return getAddressPortfolio(address, prettyPrint, this.client);
  }

  async claimAllRewards(updateOracle: boolean = true) {
    let txb = await claimAllRewardsPTB(this.client, this.address);
    txb.setSender(this.address);
    const result = SignAndSubmitTXB(txb, this.client, this.keypair);
    return result;
  }

  async stakeSuitoVoloSui(stakeAmount: number) {
    let txb = new Transaction();
    txb.setSender(this.address);

    assert(stakeAmount >= 1e9, "Stake amount should be greater than 1Sui");
    const [toSwapSui] = txb.splitCoins(txb.gas, [stakeAmount]);

    const vSuiCoin = await stakeTovSuiPTB(txb, toSwapSui);
    txb.transferObjects([vSuiCoin], this.address);

    const result = SignAndSubmitTXB(txb, this.client, this.keypair);
    return result;
  }

  async unstakeSuiFromVoloSui(unstakeAmount: number = -1) {
    let txb = new Transaction();
    txb.setSender(this.address);

    let coinInfo = await this.getCoins(vSui.address);

    if (coinInfo.data.length >= 2) {
      const txbMerge = new Transaction();
      txbMerge.setSender(this.address);
      let baseObj = coinInfo.data[0].objectId;
      let allList = coinInfo.data.slice(1).map((coin) => coin.objectId);

      txbMerge.mergeCoins(baseObj, allList);
      await SignAndSubmitTXB(txbMerge, this.client, this.keypair);
    }

    coinInfo = await this.getCoins(vSui.address);
    if (unstakeAmount == -1) {
      unstakeAmount = Number(coinInfo.data[0].balance);
    }
    assert(unstakeAmount >= 1e9, "Unstake amount should >= 1vSui");

    let mergedCoin = txb.object(coinInfo.data[0].objectId);
    const [splittedCoin] = txb.splitCoins(mergedCoin, [unstakeAmount]);
    await unstakeTovSui(txb, splittedCoin);

    const result = SignAndSubmitTXB(txb, this.client, this.keypair);
    return result;
  }

  async updateOracle() {
    let txb = new Transaction();
    txb.setSender(this.address);
    await updateOraclePTB(this.client, txb);

    const result = SignAndSubmitTXB(txb, this.client, this.keypair);
    return result;
  }

  async swap(
    fromCoinAddress: string,
    toCoinAddress: string,
    amountIn: number | string | bigint,
    minAmountOut: number,
    apiKey?: string,
    swapOptions: SwapOptions = { baseUrl: undefined, dexList: [], byAmountIn: true, depth: 3 },
  ) {
    const txb = new Transaction();
    txb.setSender(this.address);

    const coinA = await getCoinPTB(this.address, fromCoinAddress, amountIn, txb, this.client);

    const finalCoinB = await swapPTB(
      this.address,
      txb,
      fromCoinAddress,
      toCoinAddress,
      coinA,
      amountIn,
      minAmountOut,
      apiKey,
      swapOptions,
    );
    txb.transferObjects([finalCoinB], this.address);

    const result = await SignAndSubmitTXB(txb, this.client, this.keypair);
    return result;
  }

  /**
   * Dry-run a swap PTB without submitting. v2 `core.simulateTransaction`
   * returns `{ Transaction } | { FailedTransaction }`; we unwrap to the
   * active variant so callers see the same flat structure they did under
   * v1 `dryRunTransactionBlock` (just with v2 ExecutionStatus +
   * BalanceChange shapes).
   */
  async dryRunSwap(
    fromCoinAddress: string,
    toCoinAddress: string,
    amountIn: number | string | bigint,
    minAmountOut: number,
    apiKey?: string,
    swapOptions: SwapOptions = { baseUrl: undefined, dexList: [], byAmountIn: true, depth: 3 },
  ) {
    const txb = new Transaction();
    txb.setSender(this.address);

    const coinA = await getCoinPTB(this.address, fromCoinAddress, amountIn, txb, this.client);

    const finalCoinB = await swapPTB(
      this.address,
      txb,
      fromCoinAddress,
      toCoinAddress,
      coinA,
      amountIn,
      minAmountOut,
      apiKey,
      swapOptions,
    );
    txb.transferObjects([finalCoinB], this.address);

    const dryRunResult = await this.client.core.simulateTransaction({
      transaction: txb,
      include: { effects: true, events: true, balanceChanges: true },
    });

    return dryRunResult.Transaction ?? dryRunResult.FailedTransaction;
  }
}
