import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import type { ClientWithCoreApi } from '@mysten/sui/client';
import { getConfig, pool } from '../../address';
import { Pool, PoolConfig, OptionType } from '../../types';
import { registerStructs } from '../PTB';
import { parseBcsTypeString } from '../bcs';

// ---------------------------------------------------------------------------
// CallFunctions — v2 Core API.
//
// Pre-fork the SDK relied on:
//   - `client.devInspectTransactionBlock` returning `DevInspectResults`
//     (a v1 JSON-RPC envelope with `results[*].returnValues: [bytes, type][]`).
//   - `client.getDynamicFieldObject` returning the v1 `SuiObjectResponse`
//     shape walkable as `result.data.content.fields.value...`.
//   - `bcs.de(typeStr, bytes)` from `@mysten/sui.js/bcs` (legacy v0.54)
//     for dynamic-string-based BCS decoding of the move-call return values.
//
// Post-fork (this file):
//   - `core.simulateTransaction({ checksEnabled: false })` is the v2
//     equivalent of devInspect. The result envelope is
//     `{ Transaction } | { FailedTransaction }`; `commandResults: true`
//     surfaces each command's `returnValues: { bcs: Uint8Array }[]`.
//     v2 doesn't include the type tag inline — every callsite must pass an
//     explicit `parseType` (it already did for every meaningful caller).
//   - `core.getDynamicObjectField({ parentId, name: { type, bcs } })`
//     replaces `getDynamicFieldObject`. v2 expects the dynamic-field name
//     as BCS bytes; we encode `u8` and `address` inline. Response shape
//     `{ object: Object<Include> }` is wrapped to look like the v1
//     `{ data: { content: { fields, dataType } } }` walker so downstream
//     field-walking code (`borrowIndexData.data?.content?.fields.value...`)
//     stays untouched.
//   - `parseBcsTypeString` (src/libs/bcs.ts) maps the legacy type-string
//     parameter to a v2 typed `BcsType<T>` and parses the bytes.
// ---------------------------------------------------------------------------

interface SimResult {
  results?: Array<{
    returnValues?: Array<[number[], string]>;
  }>;
  error?: string;
}

/**
 * Adapt the v2 `core.simulateTransaction` response into the v1
 * `DevInspectResults` shape that `inspectResultParseAndPrint` walks. v2
 * commandResults expose `returnValues[].bcs: Uint8Array` and don't echo the
 * Move type tag — we paper that over by leaving the second tuple element
 * blank since every meaningful caller passes `parseType` explicitly.
 */
function adaptSimulateResult(result: any): SimResult {
  const tx = result.Transaction ?? result.FailedTransaction;
  if (!tx) return { error: 'simulateTransaction returned no transaction envelope' };
  if (tx.effects?.status && !tx.effects.status.success) {
    const err = tx.effects.status.error;
    return { error: typeof err === 'string' ? err : JSON.stringify(err) };
  }
  const cmds = result.commandResults ?? [];
  const lastCmd = cmds[cmds.length - 1];
  if (!lastCmd) return { results: [] };
  const returnValues: Array<[number[], string]> = (lastCmd.returnValues ?? []).map((rv: { bcs: Uint8Array }) => {
    return [Array.from(rv.bcs), ''];
  });
  return { results: [{ returnValues }] };
}

/**
 * Parses and prints the inspection results.
 */
function inspectResultParseAndPrint(data: SimResult, _funName: string, parseType?: string) {
  if (data.results && data.results.length > 0) {
    if (data.results[0].returnValues && data.results[0].returnValues.length > 0) {
      const values: any[] = [];
      for (const v of data.results[0].returnValues) {
        let _type = parseType ? parseType : v[1];
        if (_type === 'vector<0x1::ascii::String>') {
          _type = 'vector<string>';
        }
        if (!_type) {
          throw new Error(
            'inspectResultParseAndPrint: v2 simulateTransaction does not echo the Move type tag — pass an explicit parseType.',
          );
        }
        const bcsType = parseBcsTypeString(_type);
        const result = bcsType.parse(Uint8Array.from(v[0]));
        values.push(result);
      }
      return values;
    }
  } else if (data.error) {
    console.log(`Get an error, msg: ${data.error}`);
  }
  return [];
}

async function moveInspectImpl(txb: Transaction, client: ClientWithCoreApi, sender: string, funName: string, typeName?: string) {
  txb.setSenderIfNotSet(sender);
  const sim = await client.core.simulateTransaction({
    transaction: txb,
    checksEnabled: false,
    include: { effects: true, commandResults: true },
  });
  const adapted = adaptSimulateResult(sim);
  return inspectResultParseAndPrint(adapted, funName, typeName);
}

/**
 * Moves and inspects a function call.
 */
export async function moveInspect(
  tx: Transaction,
  client: ClientWithCoreApi,
  sender: string,
  target: `${string}::${string}::${string}`,
  args: any[],
  typeArgs?: string[],
  typeName?: string,
) {
  const funcName = target.split('::');

  tx.moveCall({
    target,
    arguments: args,
    typeArguments: typeArgs,
  });
  return await moveInspectImpl(tx, client, sender, funcName.slice(1, 3).join('::'), typeName);
}

/**
 * Encode a dynamic-field-name VALUE as BCS bytes for v2
 * `core.getDynamicObjectField({ name: { type, bcs } })`. The encodings here
 * mirror the inline serialization v1 `getDynamicFieldObject` did for us
 * automatically, restricted to the (`u8`, `address`, `vector<u8>`) shapes
 * NAVI actually uses.
 */
function encodeDynamicFieldName(type: string, value: any): Uint8Array {
  if (type === 'u8') {
    return bcs.u8().serialize(Number(value)).toBytes();
  }
  if (type === 'address') {
    return bcs.Address.serialize(String(value)).toBytes();
  }
  if (type === 'vector<u8>') {
    const bytes = typeof value === 'string'
      ? Array.from(new TextEncoder().encode(value))
      : Array.from(value as Iterable<number>);
    return bcs.vector(bcs.u8()).serialize(bytes).toBytes();
  }
  throw new Error(`Unsupported dynamic-field name type: ${type}`);
}

/**
 * Wraps `core.getDynamicObjectField` in the v1 `SuiObjectResponse` envelope
 * (`{ data: { objectId, type, content: { dataType, fields } } }`) that the
 * existing field walkers consume. Move struct content is sourced from
 * `obj.object.json`.
 */
async function getDynamicFieldObjectV1Shape(
  client: ClientWithCoreApi,
  parentId: string,
  name: { type: string; value: any },
): Promise<any> {
  const nameBcs = encodeDynamicFieldName(name.type, name.value);
  const result = await client.core.getDynamicObjectField({
    parentId,
    name: { type: name.type, bcs: nameBcs },
    include: { json: true },
  });
  const obj = result.object;
  return {
    data: {
      objectId: obj?.objectId,
      type: obj?.type,
      content: { dataType: 'moveObject', fields: obj?.json ?? {} },
    },
  };
}

/**
 * Retrieves the detailed information of a reserve based on the provided asset ID.
 */
export async function getReservesDetail(assetId: number, client: ClientWithCoreApi) {
  const config = await getConfig();
  return await getDynamicFieldObjectV1Shape(client, config.ReserveParentId, {
    type: 'u8',
    value: assetId,
  });
}

export async function getAddressPortfolio(
  address: string,
  prettyPrint: boolean = true,
  client: ClientWithCoreApi,
  decimals?: boolean,
  tokenFilter?: (keyof Pool)[],
) {
  const balanceMap = new Map<string, { borrowBalance: number; supplyBalance: number }>();

  const validTokens = Object.keys(pool) as (keyof Pool)[];

  const filteredTokens = tokenFilter
    ? tokenFilter.filter((token) => validTokens.includes(token))
    : validTokens;

  if (tokenFilter) {
    const invalidTokens = tokenFilter.filter((token) => !validTokens.includes(token));
    if (invalidTokens.length > 0) {
      console.warn(`Some tokens passed in do not exist and have been ignored: ${invalidTokens.join(', ')}`);
    }
  }

  await Promise.all(
    filteredTokens.map(async (poolKey) => {
      const reserve: PoolConfig = pool[poolKey as keyof Pool];
      const borrowBalance: any = await getDynamicFieldObjectV1Shape(client, reserve.borrowBalanceParentId, {
        type: 'address',
        value: address,
      });
      const supplyBalance: any = await getDynamicFieldObjectV1Shape(client, reserve.supplyBalanceParentId, {
        type: 'address',
        value: address,
      });

      const borrowIndexData: any = await getReservesDetail(reserve.assetId, client);
      const borrowIndex = borrowIndexData.data?.content?.fields?.value?.fields?.current_borrow_index / Math.pow(10, 27);
      const supplyIndex = borrowIndexData.data?.content?.fields?.value?.fields?.current_supply_index / Math.pow(10, 27);

      let borrowValue = 0;
      let supplyValue = 0;

      borrowValue = borrowBalance && borrowBalance.data?.content?.fields.value !== undefined ? borrowBalance.data?.content?.fields.value / Math.pow(10, 9) : 0;
      supplyValue = supplyBalance && supplyBalance.data?.content?.fields.value !== undefined ? supplyBalance.data?.content?.fields.value / Math.pow(10, 9) : 0;
      borrowValue *= borrowIndex;
      supplyValue *= supplyIndex;

      if (!decimals) {
        borrowValue = borrowBalance && borrowBalance.data?.content?.fields.value !== undefined ? borrowBalance.data?.content?.fields.value : 0;
        supplyValue = supplyBalance && supplyBalance.data?.content?.fields.value !== undefined ? supplyBalance.data?.content?.fields.value : 0;
        borrowValue *= borrowIndex;
        supplyValue *= supplyIndex;
      }

      if (prettyPrint) {
        console.log(`| ${poolKey} | ${borrowValue} | ${supplyValue} |`);
      }
      balanceMap.set(poolKey, { borrowBalance: borrowValue, supplyBalance: supplyValue });
    }),
  );

  return balanceMap;
}

export async function getHealthFactorCall(address: string, client: ClientWithCoreApi) {
  const config = await getConfig();
  const tx = new Transaction();

  // health factor returns u256 — explicit parseType since v2 simulate doesn't
  // echo the Move type tag.
  const result: any = await moveInspect(
    tx,
    client,
    address,
    `${config.uiGetter}::logic_getter_unchecked::user_health_factor`,
    [
      tx.object('0x06'),
      tx.object(config.StorageId),
      tx.object(config.PriceOracle),
      tx.pure.address(address),
    ],
    [],
    'u256',
  );

  return result;
}

export async function getReserveData(address: string, client: ClientWithCoreApi) {
  registerStructs();
  const config = await getConfig();
  const tx = new Transaction();

  const result: any = await moveInspect(
    tx,
    client,
    address,
    `${config.uiGetter}::getter::get_reserve_data`,
    [tx.object(config.StorageId)],
    [],
    'vector<ReserveDataInfo>',
  );
  return result[0];
}

export async function getIncentiveAPY(address: string, client: ClientWithCoreApi, option: OptionType) {
  registerStructs();
  const config = await getConfig();
  const tx = new Transaction();

  const result: any = await moveInspect(
    tx,
    client,
    address,
    `${config.uiGetter}::incentive_getter::get_incentive_apy`,
    [
      tx.object('0x06'),
      tx.object(config.IncentiveV2),
      tx.object(config.StorageId),
      tx.object(config.PriceOracle),
      tx.pure.u8(option),
    ],
    [],
    'vector<IncentiveAPYInfo>',
  );

  return result[0];
}

export async function getCoinOracleInfo(client: ClientWithCoreApi, oracleIds: number[]) {
  registerStructs();
  const config = await getConfig();
  const tx = new Transaction();

  const result: any = await moveInspect(
    tx,
    client,
    '0xcda879cde94eeeae2dd6df58c9ededc60bcf2f7aedb79777e47d95b2cfb016c2',
    `${config.uiGetter}::getter::get_oracle_info`,
    [tx.object('0x06'), tx.object(config.PriceOracle), tx.pure.vector('u8', oracleIds)],
    [],
    'vector<OracleInfo>',
  );

  return result[0];
}

export async function getUserState(client: ClientWithCoreApi, address: string) {
  registerStructs();
  const config = await getConfig();
  const tx = new Transaction();

  const result: any = await moveInspect(
    tx,
    client,
    '0xcda879cde94eeeae2dd6df58c9ededc60bcf2f7aedb79777e47d95b2cfb016c2',
    `${config.uiGetter}::getter::get_user_state`,
    [tx.object(config.StorageId), tx.pure.address(address)],
    [],
    'vector<UserStateInfo>',
  );

  return result[0];
}
