import { parseAbi } from "viem";

// Robinhood Chain (chainId 4663) Uniswap deployment addresses, confirmed
// against Uniswap's own docs repo (developers.uniswap.org source), not
// guessed. Lowercased for comparison.
export const KNOWN_ROUTERS = {
  uniswapV2Router02: "0x89e5db8b5aa49aa85ac63f691524311aeb649eba",
  uniswapV3Router02: "0xcaf681a66d020601342297493863e78c959e5cb2",
  universalRouter: "0x8876789976decbfcbbbe364623c63652db8c0904",
} as const;

export const UNISWAP_V2_FACTORY = "0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f";
export const UNISWAP_V3_FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";

export const uniswapV2RouterAbi = parseAbi([
  "function WETH() view returns (address)",
  "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)",
  "function swapETHForExactTokens(uint256 amountOut, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
  "function swapTokensForExactETH(uint256 amountOut, uint256 amountInMax, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
]);

// SwapRouter02 dropped `deadline` from the params struct compared to the original SwapRouter.
export const uniswapV3Router02Abi = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256 amountOut)",
]);

// Universal Router's calldata is a packed command sequence, not simple
// function selectors -- decoding it is documented as a known limitation in
// swapDecoder.ts (see comment there) rather than implemented, since the
// live signal path watches confirmed Swap events instead (see
// chain/swapWatcher.ts) and doesn't need calldata decoding at all.
export const universalRouterAbi = parseAbi([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
]);

export const uniswapV2PairCreatedAbi = parseAbi([
  "event PairCreated(address indexed token0, address indexed token1, address pair, uint256 pairIndex)",
]);

export const uniswapV3PoolCreatedAbi = parseAbi([
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)",
]);

export const uniswapV2SwapEventAbi = parseAbi([
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
]);

export const uniswapV3SwapEventAbi = parseAbi([
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
]);

export const poolTokensAbi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);
