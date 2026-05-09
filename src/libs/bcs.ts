// ---------------------------------------------------------------------------
// v2 typed-bcs struct definitions for NAVI's devInspect-driven reads.
//
// Pre-fork these were defined as `bcs.registerStructType('TypeName', {...})`
// against `@mysten/sui.js@0.54`'s legacy bcs registry, which let
// `bcs.de(typeStr, bytes)` decode by name. v2 `@mysten/sui/bcs` removed that
// runtime registry — every type must be a typed `BcsType<T>` declared
// up-front. We migrate the registrations here and ship a small
// `parseBcsTypeString` that maps the legacy type-string parameter (still
// passed through every callsite) onto a v2 typed struct or primitive,
// recursing through `vector<...>`. Move-call return values come back as
// raw `Uint8Array` from `core.simulateTransaction` and we parse them via
// the resolved `BcsType<T>.parse(bytes)` method.
// ---------------------------------------------------------------------------

// Both `@mysten/sui/bcs` and `@mysten/bcs` export a `BcsType` class. Importing
// from `@mysten/sui/bcs` keeps the class identity matched to the one `bcs.*`
// factory functions return — otherwise TypeScript treats the two classes as
// nominally distinct because of the private `#private` brand and rejects
// assignment between them.
import { bcs, BcsType } from '@mysten/sui/bcs';

// Mirrors the legacy `IncentiveAPYInfo` registration (commonFunctions.ts).
export const IncentiveAPYInfo = bcs.struct('IncentiveAPYInfo', {
  asset_id: bcs.u8(),
  apy: bcs.u256(),
  coin_types: bcs.vector(bcs.string()),
});

export const IncentivePoolInfo = bcs.struct('IncentivePoolInfo', {
  pool_id: bcs.Address,
  funds: bcs.Address,
  phase: bcs.u64(),
  start_at: bcs.u64(),
  end_at: bcs.u64(),
  closed_at: bcs.u64(),
  total_supply: bcs.u64(),
  asset_id: bcs.u8(),
  option: bcs.u8(),
  factor: bcs.u256(),
  distributed: bcs.u64(),
  available: bcs.u256(),
  total: bcs.u256(),
});

export const IncentivePoolInfoByPhase = bcs.struct('IncentivePoolInfoByPhase', {
  phase: bcs.u64(),
  pools: bcs.vector(IncentivePoolInfo),
});

export const UserStateInfo = bcs.struct('UserStateInfo', {
  asset_id: bcs.u8(),
  borrow_balance: bcs.u256(),
  supply_balance: bcs.u256(),
});

export const ReserveDataInfo = bcs.struct('ReserveDataInfo', {
  id: bcs.u8(),
  oracle_id: bcs.u8(),
  coin_type: bcs.string(),
  supply_cap: bcs.u256(),
  borrow_cap: bcs.u256(),
  supply_rate: bcs.u256(),
  borrow_rate: bcs.u256(),
  supply_index: bcs.u256(),
  borrow_index: bcs.u256(),
  total_supply: bcs.u256(),
  total_borrow: bcs.u256(),
  last_update_at: bcs.u64(),
  ltv: bcs.u256(),
  treasury_factor: bcs.u256(),
  treasury_balance: bcs.u256(),
  base_rate: bcs.u256(),
  multiplier: bcs.u256(),
  jump_rate_multiplier: bcs.u256(),
  reserve_factor: bcs.u256(),
  optimal_utilization: bcs.u256(),
  liquidation_ratio: bcs.u256(),
  liquidation_bonus: bcs.u256(),
  liquidation_threshold: bcs.u256(),
});

export const OracleInfo = bcs.struct('OracleInfo', {
  oracle_id: bcs.u8(),
  price: bcs.u256(),
  decimals: bcs.u8(),
  valid: bcs.bool(),
});

// Mirrors the V3 `ClaimableReward` registration.
export const ClaimableReward = bcs.struct('ClaimableReward', {
  asset_coin_type: bcs.string(),
  reward_coin_type: bcs.string(),
  user_claimable_reward: bcs.u256(),
  user_claimed_reward: bcs.u256(),
  rule_ids: bcs.vector(bcs.Address),
});

// Use the looser `BcsType<any>` for the registry since each entry is a
// concrete type with its own private brand and TypeScript's type-checker
// won't unify them under `BcsType<unknown>`. Callers parse via the
// resolved instance's own `.parse(bytes)` so the `any` doesn't leak.
const PRIMITIVES: Record<string, BcsType<any>> = {
  bool: bcs.bool(),
  u8: bcs.u8(),
  u16: bcs.u16(),
  u32: bcs.u32(),
  u64: bcs.u64(),
  u128: bcs.u128(),
  u256: bcs.u256(),
  address: bcs.Address,
  string: bcs.string(),
  // 0x1::ascii::String round-trips through bcs.string() — same UTF-8 layout.
  '0x1::ascii::String': bcs.string(),
  '0x1::string::String': bcs.string(),
};

const STRUCTS: Record<string, BcsType<any>> = {
  IncentiveAPYInfo,
  IncentivePoolInfo,
  IncentivePoolInfoByPhase,
  UserStateInfo,
  ReserveDataInfo,
  OracleInfo,
  ClaimableReward,
};

/**
 * Resolve a NAVI type-string (the same string the legacy
 * `bcs.de(typeStr, bytes)` accepted) to a v2 typed `BcsType<T>`. Recurses
 * through `vector<X>`. Throws on unknown identifiers so a missing
 * registration surfaces as a real error instead of silently decoding wrong.
 */
export function parseBcsTypeString(typeStr: string): BcsType<any> {
  const trimmed = typeStr.trim();
  if (PRIMITIVES[trimmed]) return PRIMITIVES[trimmed];
  if (STRUCTS[trimmed]) return STRUCTS[trimmed];
  if (trimmed.startsWith('vector<') && trimmed.endsWith('>')) {
    const inner = trimmed.slice(7, -1);
    return bcs.vector(parseBcsTypeString(inner));
  }
  throw new Error(`Unknown bcs type string: ${typeStr}`);
}
