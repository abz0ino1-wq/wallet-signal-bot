import { httpClient } from "./viemClient";
import { KNOWN_ROUTERS, NATIVE_TOKEN_SENTINEL, uniswapV2RouterAbi } from "../decode/uniswapAbi";
import { config } from "../config";
import { logger } from "../utils/logger";

let resolved: string | null = null;

/**
 * Resolves the chain's wrapped-native-token address by calling the
 * deployed Router02 contract's own `WETH()` getter, rather than hardcoding
 * an address that could be wrong for a chain we haven't manually verified.
 * Must be awaited once at startup before any code calls getWeth().
 */
export async function resolveWeth(): Promise<string> {
  if (resolved) return resolved;

  if (config.wethOverride) {
    resolved = config.wethOverride;
    logger.info(`WETH address from WETH_ADDRESS override: ${resolved}`);
    return resolved;
  }

  const address = await httpClient.readContract({
    address: KNOWN_ROUTERS.uniswapV2Router02 as `0x${string}`,
    abi: uniswapV2RouterAbi,
    functionName: "WETH",
  });
  resolved = (address as string).toLowerCase();
  logger.info(`WETH address resolved on-chain via Router02: ${resolved}`);
  return resolved;
}

export function getWeth(): string {
  if (!resolved) {
    throw new Error("WETH address not resolved yet -- call resolveWeth() at startup before using getWeth().");
  }
  return resolved;
}

/**
 * V4 pools commonly pair directly against native ETH (the zero-address
 * sentinel) instead of wrapped WETH -- treat both as "the ETH side" of a
 * pair wherever we check for WETH-denominated pools.
 */
export function isWethOrNative(address: string): boolean {
  const lower = address.toLowerCase();
  return lower === getWeth() || lower === NATIVE_TOKEN_SENTINEL;
}
