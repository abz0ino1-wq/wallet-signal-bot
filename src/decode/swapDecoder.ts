import { decodeFunctionData, formatEther, type Hex } from "viem";
import { getWeth } from "../chain/weth";
import type { DecodedSwap } from "../types";
import { KNOWN_ROUTERS, uniswapV2RouterAbi, uniswapV3Router02Abi } from "./uniswapAbi";

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

function nonWethToken(path: string[], weth: string): string | null {
  return path.find((t) => t.toLowerCase() !== weth) ?? null;
}

/**
 * Best-effort decode of a transaction's calldata into a WETH<->token swap.
 * Covers Uniswap V2 Router02 and V3 SwapRouter02 only. Returns null for
 * calldata we don't recognize -- most importantly Universal Router's
 * packed command encoding (`execute(bytes commands, bytes[] inputs, ...)`),
 * which is the *preferred* entrypoint on Robinhood Chain per Uniswap's own
 * docs. This means historical wallet-scoring (which replays a wallet's own
 * past router calls) will undercount trades made via Universal Router --
 * a real gap, documented in the README, not silently papered over. The
 * live signal path doesn't have this gap: it watches confirmed Swap events
 * directly (see chain/swapWatcher.ts) rather than decoding router calldata,
 * so it sees every swap regardless of which router/entrypoint was used.
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
  const weth = getWeth();

  try {
    if (router === KNOWN_ROUTERS.uniswapV2Router02) {
      const decoded = decodeFunctionData({ abi: uniswapV2RouterAbi, data: input });
      const args = decoded.args as readonly unknown[];

      switch (decoded.functionName) {
        case "swapExactETHForTokens":
        case "swapETHForExactTokens": {
          const path = (args[1] as string[]).map((a) => a.toLowerCase());
          const token = nonWethToken(path, weth);
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
          const token = nonWethToken(path, weth);
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
          if (!path.includes(weth)) return null; // not a WETH-denominated swap, skip
          const token = nonWethToken(path, weth);
          if (!token) return null;
          const side = path[0] === weth ? "buy" : "sell";
          return { txHash, trader: from.toLowerCase(), tokenAddress: token, side, ethAmount: null, router };
        }
      }
      return null;
    }

    if (router === KNOWN_ROUTERS.uniswapV3Router02) {
      const decoded = decodeFunctionData({ abi: uniswapV3Router02Abi, data: input });

      if (decoded.functionName === "exactInputSingle") {
        const p = decoded.args[0] as { tokenIn: string; tokenOut: string; amountIn: bigint };
        const tokenIn = p.tokenIn.toLowerCase();
        const tokenOut = p.tokenOut.toLowerCase();
        if (tokenIn !== weth && tokenOut !== weth) return null;
        const side = tokenIn === weth ? "buy" : "sell";
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
        if (!tokens.includes(weth)) return null;
        const token = nonWethToken(tokens, weth);
        if (!token) return null;
        const side = tokens[0] === weth ? "buy" : "sell";
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
