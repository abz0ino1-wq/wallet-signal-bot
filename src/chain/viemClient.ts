import { createPublicClient, http, webSocket } from "viem";
import { robinhood } from "viem/chains";
import { config } from "../config";

export const wsClient = createPublicClient({
  chain: robinhood,
  transport: webSocket(config.rpc.wsUrl, {
    reconnect: { attempts: Infinity, delay: 2_000 },
    keepAlive: true,
  }),
});

export const httpClient = createPublicClient({
  chain: robinhood,
  transport: http(config.rpc.httpUrl),
});
