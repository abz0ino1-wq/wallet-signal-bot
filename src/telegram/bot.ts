import { Telegraf } from "telegraf";
import { config } from "../config";
import { signalsRepo } from "../db";
import type { SignalRecord } from "../types";
import { logger } from "../utils/logger";

let bot: Telegraf | null = null;

function getBot(): Telegraf {
  if (!bot) bot = new Telegraf(config.telegram.botToken);
  return bot;
}

export async function sendSignalToTelegram(signal: SignalRecord): Promise<void> {
  try {
    await getBot().telegram.sendMessage(config.telegram.chatId, signal.message, {
      link_preview_options: { is_disabled: true },
    });
    if (signal.id) signalsRepo.markSent(signal.id);
  } catch (err) {
    logger.error("Failed to send Telegram message:", (err as Error).message);
  }
}

export async function sendPlainMessage(text: string): Promise<void> {
  try {
    await getBot().telegram.sendMessage(config.telegram.chatId, text);
  } catch (err) {
    logger.error("Failed to send Telegram message:", (err as Error).message);
  }
}
