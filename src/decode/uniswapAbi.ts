import { parseAbi } from "viem";

// Known Ethereum mainnet router/factory addresses (lowercased for comparison).
export const KNOWN_ROUTERS = {
  uniswapV2Router02: "0x7a250d5630b4cf539739df2c5dacb4c659f2488d",
  uniswapV3Router: "0xe592427a0aece92de3edee1f18e0157c05861564",
  uniswapV3Router02: "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45",
  universalRouter: "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
} as const;

export const UNISWAP_V2_FACTORY = "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f";
export const UNISWAP_V3_FACTORY = "0x1f98431c8ad98523631ae4a59f267346ea31f984";

export const uniswapV2RouterAbi = parseAbi([
  "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)",
  "function swapETHForExactTokens(uint256 amountOut, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
  "function swapTokensForExactETH(uint256 amountOut, uint256 amountInMax, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
]);

export const uniswapV3RouterAbi = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256 amountOut)",
]);

// SwapRouter02 dropped `deadline` from the params struct compared to the original SwapRouter.
export const uniswapV3Router02Abi = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256 amountOut)",
]);

export const uniswapV2PairCreatedAbi = parseAbi([
  "event PairCreated(address indexed token0, address indexed token1, address pair, uint256 pairIndex)",
]);

export const uniswapV3PoolCreatedAbi = parseAbi([
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)",
]);
