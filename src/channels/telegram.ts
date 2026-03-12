import { Bot, InlineKeyboard } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { getDb } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  formatHeartbeatSummary,
  formatMonthlySummary,
  formatTodayDetail,
  formatWeekSummary,
  getHeartbeatSummary,
  getMonthSummary,
  getTodayDetail,
  getWeekSummary,
} from '../cost-tracker.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  ButtonAction,
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';
import { HeartbeatTickResult, HeartbeatState } from '../heartbeat-types.js';
import { getHeartbeatChecks, readHeartbeatState } from '../heartbeat-runner.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  onHeartbeatTick?: () => Promise<HeartbeatTickResult>;
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken);

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Debug command: sends a test message with inline buttons
    this.bot.command('testbuttons', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      await this.sendMessageWithButtons(
        chatJid,
        '🧪 Test message with buttons',
        [
          {
            label: '✓ Whitelist',
            value: 'email_action:whitelist:test@example.com',
          },
          { label: '✗ Block', value: 'email_action:block:test@example.com' },
          { label: '– Ignore', value: 'email_action:ignore:test@example.com' },
        ],
      );
    });

    // Cost tracking commands
    this.bot.command('costs', async (ctx) => {
      try {
        const db = getDb();
        const sub = (ctx.match ?? '').trim().toLowerCase();
        let text: string;
        if (sub === 'today') {
          text = formatTodayDetail(getTodayDetail(db));
        } else if (sub === 'week') {
          text = formatWeekSummary(getWeekSummary(db));
        } else if (sub === 'heartbeat') {
          text = formatHeartbeatSummary(getHeartbeatSummary(db));
        } else {
          text = formatMonthlySummary(getMonthSummary(db));
        }
        await ctx.reply(text);
      } catch (err) {
        logger.error({ err }, 'Failed to handle /costs command');
        await ctx.reply('Error fetching cost data.');
      }
    });

    // Run one heartbeat tick immediately.
    // The tick can take 10–30 min (container runtime), so we fire it in the
    // background and reply immediately. grammY processes updates sequentially
    // per chat — awaiting a long container here would block all subsequent
    // commands (/heartbeat_status etc.) until the container finishes.
    this.bot.command('heartbeat', async (ctx) => {
      if (!this.opts.onHeartbeatTick) {
        await ctx.reply('Heartbeat not configured.');
        return;
      }
      const chatJid = `tg:${ctx.chat.id}`;
      await ctx.reply(
        '⏳ Heartbeat tick triggered. Result will arrive as a message when the check completes.',
      );
      // Fire-and-forget — handler returns immediately so grammY can process
      // the next update for this chat (e.g. /heartbeat_status).
      this.opts
        .onHeartbeatTick()
        .then(async (result) => {
          if (result.status === 'skipped' || !result.checkId) {
            await this.sendMessage(
              chatJid,
              'ℹ️ No check due or outside active window.',
            );
          } else {
            const emoji =
              result.status === 'ok'
                ? '✅'
                : result.status === 'alert'
                  ? '⚠️'
                  : '❌';
            await this.sendMessage(
              chatJid,
              `${emoji} [${result.checkName}]: ${result.status.toUpperCase()}${result.summary ? '\n' + result.summary : ''}`,
            );
          }
        })
        .catch((err) =>
          logger.error({ err }, 'Failed to run background heartbeat tick'),
        );
    });

    // Show heartbeat check status (underscore required — Telegram forbids hyphens)
    this.bot.command('heartbeat_status', async (ctx) => {
      try {
        const state: HeartbeatState = readHeartbeatState();
        const lines = getHeartbeatChecks().map((c) => {
          const cs = state.checks[c.id];
          if (!cs) return `  ${c.name}: never run`;
          const ageMin = Math.round(
            (Date.now() - new Date(cs.lastRun).getTime()) / 60_000,
          );
          const icon =
            cs.lastResult === 'ok'
              ? '✅'
              : cs.lastResult === 'error'
                ? '❌'
                : '⚠️';
          const suffix =
            cs.lastResult === 'error'
              ? ` — ERROR: ${cs.lastSummary ?? 'unknown'}`
              : cs.lastSummary
                ? ` — ${cs.lastSummary}`
                : '';
          return `  ${icon} ${c.name}: ${ageMin}min ago${suffix}`;
        });
        lines.unshift('Heartbeat status:');
        if (state.currentRun) {
          const runMin = Math.round(
            (Date.now() - new Date(state.currentRun.startedAt).getTime()) /
              60_000,
          );
          lines.push(
            `\n🔄 Running now: ${state.currentRun.checkName} (${runMin}min)`,
          );
        }
        lines.push(`Last tick: ${state.lastTick || 'never'}`);
        await ctx.reply(lines.join('\n'));
      } catch (err) {
        logger.error({ err }, 'Failed to handle /heartbeat_status command');
        await ctx.reply('Error fetching heartbeat status.');
      }
    });

    // Handle inline button taps (callback queries)
    this.bot.on('callback_query:data', async (ctx) => {
      const callbackData = ctx.callbackQuery.data;

      // 1. Answer immediately to dismiss the loading spinner
      await ctx.answerCallbackQuery();

      // 2. Edit the original message: append which button was tapped, remove keyboard
      const msg = ctx.callbackQuery.message;
      if (msg && 'text' in msg) {
        // Find the button label from the stored keyboard
        let buttonLabel = callbackData;
        if (msg.reply_markup?.inline_keyboard) {
          for (const row of msg.reply_markup.inline_keyboard) {
            for (const btn of row) {
              if (
                'callback_data' in btn &&
                btn.callback_data === callbackData
              ) {
                buttonLabel = btn.text;
                break;
              }
            }
          }
        }
        try {
          await ctx.editMessageText(`${msg.text}\n\n✓ ${buttonLabel}`, {
            reply_markup: new InlineKeyboard(),
          });
        } catch (err) {
          logger.debug({ err }, 'Failed to edit callback query message');
        }
      }

      // 3. Route the callback as an inbound message (same as if the user typed it)
      const chatId = msg?.chat.id ?? ctx.from.id;
      const chatJid = `tg:${chatId}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, callbackData },
          'Callback from unregistered chat, ignoring',
        );
        return;
      }

      const timestamp = new Date().toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';

      this.opts.onMessage(chatJid, {
        id: `cb-${ctx.callbackQuery.id}`,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content: callbackData,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, callbackData, sender: senderName },
        'Callback query routed as message',
      );
    });

    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', (ctx) => storeNonText(ctx, '[Photo]'));
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await this.bot.api.sendMessage(numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await this.bot.api.sendMessage(
            numericId,
            text.slice(i, i + MAX_LENGTH),
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  async sendMessageWithButtons(
    jid: string,
    text: string,
    buttons: ButtonAction[],
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const keyboard = new InlineKeyboard();
      buttons.forEach((btn, i) => {
        keyboard.text(btn.label, btn.value);
        if (i < buttons.length - 1) keyboard.row();
      });

      await this.bot.api.sendMessage(numericId, text, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      });
      logger.info(
        { jid, buttonCount: buttons.length },
        'Telegram message with buttons sent',
      );
    } catch (err) {
      logger.error(
        { jid, err },
        'Failed to send Telegram message with buttons',
      );
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
