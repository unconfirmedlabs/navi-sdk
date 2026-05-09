// ---------------------------------------------------------------------------
// Vendored from `@pythnetwork/pyth-sui-js@2.4.0` (`dist/esm/client.mjs`),
// patched for `@mysten/sui@^2.x` (gRPC + v2 Core API).
//
// Why we vendor: the upstream package was published against
// `@mysten/sui@^1.x` and calls `provider.getObject` / `provider.getDynamicFieldObject`
// directly — both v1 methods that don't exist on `SuiGrpcClient`. Pyth has
// not shipped a v2-compatible release as of fork date (2026-05-09), and Sui's
// JSON-RPC sunset is June 2026. Vendoring + patching is the only path that
// keeps the on-chain Pyth update flow working past the sunset.
//
// Patches vs upstream:
//   - `provider.getObject({ id, options: { showContent: true } })` →
//     `client.core.getObject({ objectId, include: { json: true } })`.
//     `result.data.content.fields` walks → `obj.object.json.<field>`.
//   - `provider.getDynamicFieldObject({ parentId, name: { type, value } })` →
//     `client.core.getDynamicObjectField({ parentId, name: { type, bcs: <encoded> } })`.
//     v2 requires the dynamic-field name as BCS bytes, not a typed value
//     dict — we encode each name (`PriceIdentifier { bytes: vector<u8> }`,
//     `vector<u8>` for the price-table key) inline.
//
// On-chain behaviour is identical: the same Move calls (`vaa::parse_and_verify`,
// `pyth::create_authenticated_price_infos_using_accumulator`,
// `pyth::update_single_price_feed`, `hot_potato_vector::destroy`) run with
// the same arguments. Only the off-chain reads to discover the package id +
// price-info object id changed transports.
// ---------------------------------------------------------------------------

import { Buffer } from 'node:buffer';
import { bcs } from '@mysten/sui/bcs';
import { SUI_CLOCK_OBJECT_ID } from '@mysten/sui/utils';
import type { Transaction, TransactionObjectArgument } from '@mysten/sui/transactions';
import type { ClientWithCoreApi } from '@mysten/sui/client';

const MAX_ARGUMENT_SIZE = 16 * 1024;

export type ObjectId = string;
export type HexString = string;

export class SuiPythClient {
  private readonly provider: ClientWithCoreApi;
  private readonly pythStateId: ObjectId;
  private readonly wormholeStateId: ObjectId;
  private pythPackageId: ObjectId | undefined;
  private wormholePackageId: ObjectId | undefined;
  private priceTableInfo: { id: ObjectId; fieldType: string } | undefined;
  private priceFeedObjectIdCache: Map<string, ObjectId> = new Map();
  private baseUpdateFee: number | undefined;

  constructor(provider: ClientWithCoreApi, pythStateId: ObjectId, wormholeStateId: ObjectId) {
    this.provider = provider;
    this.pythStateId = pythStateId;
    this.wormholeStateId = wormholeStateId;
  }

  async getBaseUpdateFee(): Promise<number> {
    if (this.baseUpdateFee === undefined) {
      const result = await this.provider.core.getObject({
        objectId: this.pythStateId,
        include: { json: true },
      });
      const fields = result.object.json as Record<string, unknown> | null;
      if (!fields || typeof fields.base_update_fee !== 'number') {
        // fallback: handle string (u64 may render as string in v2 json)
        const raw = fields?.base_update_fee;
        if (raw == null) throw new Error('Unable to fetch pyth state object');
        this.baseUpdateFee = Number(raw);
      } else {
        this.baseUpdateFee = fields.base_update_fee;
      }
    }
    return this.baseUpdateFee;
  }

  /**
   * Returns the latest package id that the object belongs to. Follows the
   * `upgrade_cap.fields.package` pointer that Pyth + Wormhole state objects
   * embed for upgrade tracking.
   */
  async getPackageId(objectId: ObjectId): Promise<ObjectId> {
    const result = await this.provider.core.getObject({
      objectId,
      include: { json: true },
    });
    const state = result.object.json as Record<string, any> | null;
    if (!state) {
      throw new Error(`Cannot fetch package id for object ${objectId}`);
    }
    if ('upgrade_cap' in state) {
      // upgrade_cap is { fields: { package: <packageId> } } in the v1 walker;
      // v2 .json may flatten or preserve fields depending on the rendering. Probe both.
      const cap = state.upgrade_cap;
      const pkg = cap?.fields?.package ?? cap?.package;
      if (typeof pkg === 'string') return pkg;
    }
    throw new Error('upgrade_cap not found');
  }

  /**
   * Adds `wormhole::vaa::parse_and_verify` calls to the PTB for each VAA
   * and returns the list of verified VAA objects ready to be passed into
   * Pyth's price-update calls. On-chain shape is identical to upstream.
   */
  async verifyVaas(
    vaas: Array<Buffer | Uint8Array | number[]>,
    tx: Transaction,
  ): Promise<TransactionObjectArgument[]> {
    const wormholePackageId = await this.getWormholePackageId();
    const verifiedVaas: TransactionObjectArgument[] = [];
    for (const vaa of vaas) {
      const [verifiedVaa] = tx.moveCall({
        target: `${wormholePackageId}::vaa::parse_and_verify`,
        arguments: [
          tx.object(this.wormholeStateId),
          tx.pure(
            bcs.vector(bcs.u8()).serialize([...vaa as Uint8Array], { maxSize: MAX_ARGUMENT_SIZE }).toBytes(),
          ),
          tx.object(SUI_CLOCK_OBJECT_ID),
        ],
      });
      verifiedVaas.push(verifiedVaa);
    }
    return verifiedVaas;
  }

  async verifyVaasAndGetHotPotato(
    tx: Transaction,
    updates: Buffer[],
    packageId: string,
  ): Promise<TransactionObjectArgument> {
    if (updates.length > 1) {
      throw new Error('SDK does not support sending multiple accumulator messages in a single transaction');
    }
    const vaa = this.extractVaaBytesFromAccumulatorMessage(updates[0]);
    const verifiedVaas = await this.verifyVaas([vaa], tx);
    const [priceUpdatesHotPotato] = tx.moveCall({
      target: `${packageId}::pyth::create_authenticated_price_infos_using_accumulator`,
      arguments: [
        tx.object(this.pythStateId),
        tx.pure(
          bcs.vector(bcs.u8()).serialize([...updates[0]], { maxSize: MAX_ARGUMENT_SIZE }).toBytes(),
        ),
        verifiedVaas[0],
        tx.object(SUI_CLOCK_OBJECT_ID),
      ],
    });
    return priceUpdatesHotPotato;
  }

  async executePriceFeedUpdates(
    tx: Transaction,
    packageId: string,
    feedIds: HexString[],
    priceUpdatesHotPotato: TransactionObjectArgument,
    coins: TransactionObjectArgument[],
  ): Promise<ObjectId[]> {
    const priceInfoObjects: ObjectId[] = [];
    let coinId = 0;
    for (const feedId of feedIds) {
      const priceInfoObjectId = await this.getPriceFeedObjectId(feedId);
      if (!priceInfoObjectId) {
        throw new Error(`Price feed ${feedId} not found, please create it first`);
      }
      priceInfoObjects.push(priceInfoObjectId);
      [priceUpdatesHotPotato] = tx.moveCall({
        target: `${packageId}::pyth::update_single_price_feed`,
        arguments: [
          tx.object(this.pythStateId),
          priceUpdatesHotPotato,
          tx.object(priceInfoObjectId),
          coins[coinId],
          tx.object(SUI_CLOCK_OBJECT_ID),
        ],
      });
      coinId++;
    }
    tx.moveCall({
      target: `${packageId}::hot_potato_vector::destroy`,
      arguments: [priceUpdatesHotPotato],
      typeArguments: [`${packageId}::price_info::PriceInfo`],
    });
    return priceInfoObjects;
  }

  /**
   * Adds the necessary commands for updating the pyth price feeds to the transaction block.
   */
  async updatePriceFeeds(
    tx: Transaction,
    updates: Buffer[],
    feedIds: HexString[],
  ): Promise<ObjectId[]> {
    const packageId = await this.getPythPackageId();
    const priceUpdatesHotPotato = await this.verifyVaasAndGetHotPotato(tx, updates, packageId);
    const baseUpdateFee = await this.getBaseUpdateFee();
    const coins = tx.splitCoins(tx.gas, feedIds.map(() => tx.pure.u64(baseUpdateFee)));
    return await this.executePriceFeedUpdates(tx, packageId, feedIds, priceUpdatesHotPotato, coins as unknown as TransactionObjectArgument[]);
  }

  /**
   * Updates price feeds using the coin input for payment.
   */
  async updatePriceFeedsWithCoins(
    tx: Transaction,
    updates: Buffer[],
    feedIds: HexString[],
    coins: TransactionObjectArgument[],
  ): Promise<ObjectId[]> {
    const packageId = await this.getPythPackageId();
    const priceUpdatesHotPotato = await this.verifyVaasAndGetHotPotato(tx, updates, packageId);
    return await this.executePriceFeedUpdates(tx, packageId, feedIds, priceUpdatesHotPotato, coins);
  }

  async createPriceFeed(tx: Transaction, updates: Buffer[]): Promise<void> {
    const packageId = await this.getPythPackageId();
    if (updates.length > 1) {
      throw new Error('SDK does not support sending multiple accumulator messages in a single transaction');
    }
    const vaa = this.extractVaaBytesFromAccumulatorMessage(updates[0]);
    const verifiedVaas = await this.verifyVaas([vaa], tx);
    tx.moveCall({
      target: `${packageId}::pyth::create_price_feeds_using_accumulator`,
      arguments: [
        tx.object(this.pythStateId),
        tx.pure(
          bcs.vector(bcs.u8()).serialize([...updates[0]], { maxSize: MAX_ARGUMENT_SIZE }).toBytes(),
        ),
        verifiedVaas[0],
        tx.object(SUI_CLOCK_OBJECT_ID),
      ],
    });
  }

  async getWormholePackageId(): Promise<ObjectId> {
    if (!this.wormholePackageId) {
      this.wormholePackageId = await this.getPackageId(this.wormholeStateId);
    }
    return this.wormholePackageId;
  }

  async getPythPackageId(): Promise<ObjectId> {
    if (!this.pythPackageId) {
      this.pythPackageId = await this.getPackageId(this.pythStateId);
    }
    return this.pythPackageId;
  }

  /**
   * Retrieves the on-chain `PriceInfoObject` id for `feedId` (the 32-byte
   * Pyth price-feed identifier in hex). Pre-fork the SDK called
   * `provider.getDynamicFieldObject({ parentId, name: { type, value: { bytes: [...] } } })`;
   * v2 requires the dynamic-field name as a `{ type, bcs }` pair where `bcs`
   * is the BCS-encoded value bytes. The on-chain key shape
   * (`PriceIdentifier { bytes: vector<u8> }`) is identical — only the
   * client-side encoding changed.
   */
  async getPriceFeedObjectId(feedId: HexString): Promise<ObjectId | undefined> {
    const normalizedFeedId = feedId.replace('0x', '');
    if (!this.priceFeedObjectIdCache.has(normalizedFeedId)) {
      const { id: tableId, fieldType } = await this.getPriceTableInfo();
      const PriceIdentifier = bcs.struct('PriceIdentifier', {
        bytes: bcs.vector(bcs.u8()),
      });
      const nameBcs = PriceIdentifier.serialize({
        bytes: [...Buffer.from(normalizedFeedId, 'hex')],
      }).toBytes();
      const result = await this.provider.core.getDynamicObjectField({
        parentId: tableId,
        name: {
          type: `${fieldType}::price_identifier::PriceIdentifier`,
          bcs: nameBcs,
        },
        include: { json: true },
      });
      const fields = result.object?.json as Record<string, any> | null;
      if (!fields) return undefined;
      // The dynamic field's value is the price-info object id (an `ID`).
      this.priceFeedObjectIdCache.set(normalizedFeedId, fields.value as ObjectId);
    }
    return this.priceFeedObjectIdCache.get(normalizedFeedId);
  }

  /**
   * Pre-fork this called `getDynamicFieldObject({ parentId, name: { type: 'vector<u8>', value: 'price_info' } })`;
   * v2 needs the name as BCS bytes. `vector<u8>` of the ASCII string
   * `"price_info"` encodes as `bcs.vector(bcs.u8()).serialize([...buffer])`.
   * The on-chain table layout doesn't change.
   */
  async getPriceTableInfo(): Promise<{ id: ObjectId; fieldType: string }> {
    if (this.priceTableInfo === undefined) {
      const nameBytes = bcs
        .vector(bcs.u8())
        .serialize([...Buffer.from('price_info', 'utf-8')])
        .toBytes();
      const result = await this.provider.core.getDynamicObjectField({
        parentId: this.pythStateId,
        name: { type: 'vector<u8>', bcs: nameBytes },
        include: { json: true },
      });
      const objectType = result.object?.type;
      if (!objectType) {
        throw new Error('Price Table not found, contract may not be initialized');
      }
      let type = objectType.replace('0x2::table::Table<', '');
      type = type.replace('::price_identifier::PriceIdentifier, 0x2::object::ID>', '');
      this.priceTableInfo = {
        id: result.object.objectId,
        fieldType: type,
      };
    }
    return this.priceTableInfo;
  }

  /**
   * Extracts the VAA bytes embedded in an accumulator message.
   *
   * Layout (verbatim from upstream):
   *   header(4) + major(1) + minor(1) + trailingPayloadSize(1)
   *   + trailingPayload(<trailingPayloadSize>) + proofType(1) + vaaSize(2) + vaaBytes(<vaaSize>)
   */
  extractVaaBytesFromAccumulatorMessage(accumulatorMessage: Buffer): Buffer {
    const trailingPayloadSize = accumulatorMessage.readUint8(6);
    const vaaSizeOffset = 7 + trailingPayloadSize + 1;
    const vaaSize = accumulatorMessage.readUint16BE(vaaSizeOffset);
    const vaaOffset = vaaSizeOffset + 2;
    return accumulatorMessage.subarray(vaaOffset, vaaOffset + vaaSize);
  }
}
