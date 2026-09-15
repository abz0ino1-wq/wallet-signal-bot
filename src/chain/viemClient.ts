import { createPublicClient, http, webSocket } from "viem";
import { mainnet } from "viem/chains";
import { config } from "../config";

export const wsClient = createPublicClient({
  chain: mainnet,
  transport: webSocket(config.rpc.wsUrl, {
    reconnect: { attempts: Infinity, delay: 2_000 },
    keepAlive: true,
  }),
});

export const httpClient = createPublicClient({
  chain: mainnet,
  transport: http(config.rpc.httpUrl),
});
