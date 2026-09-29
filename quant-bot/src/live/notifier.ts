/**
 * Pushes a message when the runner does something worth knowing about, so a
 * paper or live session doesn't require someone to keep opening the log.
 * Optional everywhere: a missing or misconfigured notifier must never affect
 * a trade, only the message about it.
 */
export interface Notifier {
  notify(message: string): Promise<void>;
}

export const NoopNotifier: Notifier = {
  async notify(): Promise<void> {},
};

export interface TelegramNotifierOptions {
  readonly botToken: string;
  readonly chatId: string;
  /** Injectable for tests; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Sends a message through a Telegram bot. Create the bot with @BotFather,
 * message it once, then use https://api.telegram.org/bot<token>/getUpdates
 * to find the chat id.
 */
export class TelegramNotifier implements Notifier {
  readonly #botToken: string;
  readonly #chatId: string;
  readonly #fetch: typeof fetch;

  constructor(options: TelegramNotifierOptions) {
    this.#botToken = options.botToken;
    this.#chatId = options.chatId;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  /**
   * Reads credentials from the environment, the same rule live trading
   * credentials follow: never via argv, where they would sit in shell
   * history and `ps` output. Notifications are optional, so a missing
   * variable falls back to doing nothing rather than throwing.
   */
  static fromEnv(): Notifier {
    const botToken = process.env['QUANT_BOT_TELEGRAM_BOT_TOKEN'];
    const chatId = process.env['QUANT_BOT_TELEGRAM_CHAT_ID'];
    if (!botToken || !chatId) return NoopNotifier;
    return new TelegramNotifier({ botToken, chatId });
  }

  async notify(message: string): Promise<void> {
    const response = await this.#fetch(`https://api.telegram.org/bot${this.#botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: this.#chatId, text: message }),
    });
    if (!response.ok) {
      throw new Error(`Telegram API returned ${response.status}: ${await response.text()}`);
    }
  }
}
