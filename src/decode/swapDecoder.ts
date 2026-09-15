import { decodeFunctionData, formatEther, type Hex } from "viem";
import { config } from "../config";
import type { DecodedSwap } from "../types";
import {
  KNOWN_ROUTERS,
  uniswapV2RouterAbi,
  uniswapV3Router02Abi,
  uniswapV3RouterAbi,
} from "./uniswapAbi";

const WETH = config.weth;

/** Decodes a Uniswap V3 `path` bytes blob into its ordered list of token addresses. */
function decodeV3Path(path: Hex): string[] {
  // path = address(20) + (fee(3) + address(20)) repeated
  const hex = path.slice(2);
  const tokens: string[] = [];
  let offset = 0;
  tokens.push(`0x${hex.slice(offset, offset + 40)}`.toLowerCase());
  offset += 40;
  while (offset + 6 + 40 <= hex.length) {
    offset += 6; // skip 3-byte fee
    tokens.push(`0x${hex.slice(offset, offset + 40)}`.toLowerCase());
    offset += 40;
  }
  return tokens;
}

function nonWethToken(path: string[]): string | null {
  return path.find((t) => t.toLowerCase() !== WETH) ?? null;
}

/**
 * Best-effort decode of a pending transaction's calldata into a WETH<->token
 * swap. Covers Uniswap V2 Router02 and V3 SwapRouter/SwapRouter02. Returns
 * null for calldata we don't recognize (e.g. Universal Router's packed
 * command encoding, other DEX routers, or non-swap calls) -- those are
 * simply skipped rather than mis-decoded.
 */
export function decodeSwap(params: {
  txHash: string;
  from: string;
  to: string | null;
  input: Hex;
  valueWei: bigint;
}): DecodedSwap | null {
  const { txHash, from, to, input, valueWei } = params;
  if (!to) return null;
  const router = to.toLowerCase();

  try {
    if (router === KNOWN_ROUTERS.uniswapV2Router02) {
      const decoded = decodeFunctionData({ abi: uniswapV2RouterAbi, data: input });
      const args = decoded.args as readonly unknown[];

      switch (decoded.functionName) {
        case "swapExactETHForTokens":
        case "swapETHForExactTokens": {
          const path = (args[1] as string[]).map((a) => a.toLowerCase());
          const token = nonWethToken(path);
          if (!token) return null;
          return {
            txHash,
            trader: from.toLowerCase(),
            tokenAddress: token,
            side: "buy",
            ethAmount: Number(formatEther(valueWei)),
            router,
          };
        }
        case "swapExactTokensForETH":
        case "swapTokensForExactETH": {
          const path = (args[2] as string[]).map((a) => a.toLowerCase());
          const token = nonWethToken(path);
          if (!token) return null;
          return {
            txHash,
            trader: from.toLowerCase(),
            tokenAddress: token,
            side: "sell",
            ethAmount: null, // unknown until execution (amountOutMin is only a floor)
            router,
          };
        }
        case "swapExactTokensForTokens": {
          const path = (args[2] as string[]).map((a) => a.toLowerCase());
          if (!path.includes(WETH)) return null; // not a WETH-denominated swap, skip
          const token = nonWethToken(path);
          if (!token) return null;
          const side = path[0] === WETH ? "buy" : "sell";
          return { txHash, trader: from.toLowerCase(), tokenAddress: token, side, ethAmount: null, router };
        }
      }
      return null;
    }

    if (router === KNOWN_ROUTERS.uniswapV3Router || router === KNOWN_ROUTERS.uniswapV3Router02) {
      const abi = router === KNOWN_ROUTERS.uniswapV3Router ? uniswapV3RouterAbi : uniswapV3Router02Abi;
      const decoded = decodeFunctionData({ abi, data: input });

      if (decoded.functionName === "exactInputSingle") {
        const p = decoded.args[0] as { tokenIn: string; tokenOut: string; amountIn: bigint };
        const tokenIn = p.tokenIn.toLowerCase();
        const tokenOut = p.tokenOut.toLowerCase();
        if (tokenIn !== WETH && tokenOut !== WETH) return null;
        const side = tokenIn === WETH ? "buy" : "sell";
        const token = side === "buy" ? tokenOut : tokenIn;
        return {
          txHash,
          trader: from.toLowerCase(),
          tokenAddress: token,
          side,
          ethAmount: side === "buy" ? Number(formatEther(p.amountIn)) : null,
          router,
        };
      }

      if (decoded.functionName === "exactInput") {
        const p = decoded.args[0] as { path: Hex; amountIn: bigint };
        const tokens = decodeV3Path(p.path);
        if (!tokens.includes(WETH)) return null;
        const token = nonWethToken(tokens);
        if (!token) return null;
        const side = tokens[0] === WETH ? "buy" : "sell";
        return {
          txHash,
          trader: from.toLowerCase(),
          tokenAddress: token,
          side,
          ethAmount: side === "buy" ? Number(formatEther(p.amountIn)) : null,
          router,
        };
      }
      return null;
    }
  } catch {
    // Calldata didn't match any known function signature for this router -- ignore.
    return null;
  }

  return null;
}
