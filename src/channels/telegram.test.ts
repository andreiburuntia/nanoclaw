import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Build a fake Grammy Bot
type MessageHandler = (ctx: any) => void | Promise<void>;
type ErrorHandler = (err: any) => void;

let textHandlers: MessageHandler[] = [];
let commandHandlers: Record<string, MessageHandler> = {};
let filterHandlers: Record<string, MessageHandler> = {};
let errorHandler: ErrorHandler | null = null;
let botStarted = false;

const fakeApi = {
  sendMessage: vi.fn().mockResolvedValue(undefined),
  sendChatAction: vi.fn().mockResolvedValue(undefined),
};

vi.mock('grammy', () => {
  class FakeBot {
    api = fakeApi;
    command(cmd: string, handler: MessageHandler) {
      commandHandlers[cmd] = handler;
    }
    on(filter: string, handler: MessageHandler) {
      if (filter === 'message:text') {
        textHandlers.push(handler);
      } else {
        filterHandlers[filter] = handler;
      }
    }
    catch(handler: ErrorHandler) {
      errorHandler = handler;
    }
    start({ onStart }: { onStart: (info: any) => void }) {
      botStarted = true;
      onStart({ username: 'andy_ai_bot', id: 12345 });
    }
    stop() {
      botStarted = false;
    }
  }
  return { Bot: FakeBot };
});

import { TelegramChannel, TelegramChannelOpts } from './telegram.js';

// --- Test helpers ---

function createTestOpts(overrides?: Partial<TelegramChannelOpts>): TelegramChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'tg:-1001234567890': {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function makeTextCtx(overrides: {
  chatId?: number;
  chatType?: string;
  chatTitle?: string;
  text?: string;
  fromId?: number;
  firstName?: string;
  username?: string;
  messageId?: number;
  date?: number;
  entities?: any[];
}) {
  const chatId = overrides.chatId ?? -1001234567890;
  const chatType = overrides.chatType ?? 'group';
  return {
    chat: {
      id: chatId,
      type: chatType,
      title: overrides.chatTitle ?? 'Test Group',
    },
    from: {
      id: overrides.fromId ?? 999,
      first_name: overrides.firstName ?? 'Alice',
      username: overrides.username ?? 'alice',
    },
    message: {
      text: overrides.text ?? 'Hello',
      message_id: overrides.messageId ?? 1,
      date: overrides.date ?? Math.floor(Date.now() / 1000),
      entities: overrides.entities ?? [],
    },
    me: { username: 'andy_ai_bot' },
    reply: vi.fn(),
  };
}

function makeMediaCtx(overrides: {
  chatId?: number;
  chatType?: string;
  fromId?: number;
  firstName?: string;
  messageId?: number;
  date?: number;
  caption?: string;
  extra?: Record<string, any>;
}) {
  const chatId = overrides.chatId ?? -1001234567890;
  return {
    chat: {
      id: chatId,
      type: overrides.chatType ?? 'group',
      title: 'Test Group',
    },
    from: {
      id: overrides.fromId ?? 999,
      first_name: overrides.firstName ?? 'Alice',
      username: 'alice',
    },
    message: {
      message_id: overrides.messageId ?? 1,
      date: overrides.date ?? Math.floor(Date.now() / 1000),
      caption: overrides.caption,
      document: overrides.extra?.document,
      sticker: overrides.extra?.sticker,
    },
  };
}

async function triggerTextMessage(ctx: any) {
  for (const handler of textHandlers) {
    await handler(ctx);
  }
}

async function triggerMediaMessage(filter: string, ctx: any) {
  const handler = filterHandlers[filter];
  if (handler) await handler(ctx);
}

// --- Tests ---

describe('TelegramChannel', () => {
  beforeEach(() => {
    textHandlers = [];
    commandHandlers = {};
    filterHandlers = {};
    errorHandler = null;
    botStarted = false;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() when bot starts', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('fake-token', opts);

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('fake-token', opts);

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('disconnect is safe when not connected', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('fake-token', opts);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Commands ---

  describe('commands', () => {
    it('/chatid returns chat info in a group', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('fake-token', opts);
      await channel.connect();

      const ctx = {
        chat: { id: -1001234567890, type: 'group', title: 'My Group' },
        from: { first_name: 'Alice' },
        reply: vi.fn(),
      };

      await commandHandlers['chatid'](ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('tg:-1001234567890'),
        expect.objectContaining({ parse_mode: 'Markdown' }),
      );
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('My Group'),
        expect.anything(),
      );
    });

    it('/chatid returns chat info in a private chat', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('fake-token', opts);
      await channel.connect();

      const ctx = {
        chat: { id: 123456789, type: 'private' },
        from: { first_name: 'Bob' },
        reply: vi.fn(),
      };

      await commandHandlers['chatid'](ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('tg:123456789'),
        expect.anything(),
      );
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Bob'),
        expect.anything(),
      );
    });

    it('/ping replies with assistant name', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('fake-token', opts);
      await channel.connect();

      const ctx = { reply: vi.fn() };
      await commandHandlers['ping'](ctx);

      expect(ctx.reply).toHaveBeenCalledWith('Andy is online.');
    });
  });

  // --- Message handling ---

  describe('message handling', () => {
    it('delivers message for registered group', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('fake-token', opts);
      await channel.connect();

      const ctx = makeTextCtx({ text: 'Hello Andy' });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:-1001234567890',
        expect.any(String),
        'Test Group',
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:-1001234567890',
        expect.objectContaining({
          id: '1',
          chat_jid: 'tg:-1001234567890',
          content: 'Hello Andy',
          sender_name: 'Alice',
          is_from_me: false,
        }),
      );
    });

    it('only emits metadata for unregistered chats', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('fake-token', opts);
      await channel.connect();

      const ctx = makeTextCtx({ chatId: 999999, chatType: 'private', firstName: 'Bob' });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:999999',
        expect.any(String),
        'Bob',
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips command messages', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('fake-token', opts);
      await channel.connect();

      const ctx = makeTextCtx({ text: '/start' });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('uses chat title for groups, sender name for private chats', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'tg:123': {
            name: 'DM',
            folder: 'dm',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new TelegramChannel('fake-token', opts);
      await channel.connect();

      const ctx = makeTextCtx({
        chatId: 123,
        chatType: 'private',
        firstName: 'Carol',
      });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:123',
        expect.any(String),
        'Carol',
      );
    });

    it('uses sender id as fallback when name/username absent', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('fake-token', opts);
      await channel.connect();

      const ctx = makeTextCtx({ text: 'No name' });
      ctx.from = { id: 42 } as any;
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:-1001234567890',
        expect.objectContaining({ sender_name: '42', sender: '42' }),
      );
    });
  });

  // --- @mention trigger translation ---

  describe('@mention trigger translation', () => {
    it('prepends trigger when bot is @mentioned', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('fake-token', opts);
      await channel.connect();

      const ctx = makeTextCtx({
        text: '@andy_ai_bot what time is it?',
        entities: [{ type: 'mention', offset: 0, length: 12 }],
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:-1001234567890',
        expect.objectContaining({
          content: '@Andy @andy_ai_bot what time is it?',
        }),
      );
    });

    it('does not prepend trigger when message already matches TRIGGER_PATTERN', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('fake-token', opts);
      await channel.connect();

      const ctx = makeTextCtx({
        text: '@Andy do something',
        entities: [{ type: 'mention', offset: 0, length: 5 }],
      });
      // This already matches ^@Andy\b, so no prepend
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:-1001234567890',
        expect.objectContaining({
          content: '@Andy do something',
        }),
      );
    });

    it('does not prepend trigger when bot is not @mentioned', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('fake-token', opts);
      await channel.connect();

      const ctx = makeTextCtx({
        text: '@someone_else hello',
        entities: [{ type: 'mention', offset: 0, length: 13 }], // @someone_else = 13 chars
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:-1001234567890',
        expect.objectContaining({
          content: '@someone_else hello',
        }),
      );
    });

    it('handles mention in the middle of text', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('fake-token', opts);
      await channel.connect();

      const ctx = makeTextCtx({
        text: 'hey @andy_ai_bot can you help?',
        entities: [{ type: 'mention', offset: 4, length: 12 }],
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:-1001234567890',
        expect.objectContaining({
          content: '@Andy hey @andy_ai_bot can you help?',
        }),
      );
    });
  });

  // --- Non-text message handling ---

  describe('non-text messages', () => {
    it('stores [Photo] placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('fake-token', opts);
      await channel.connect();

      const ctx = makeMediaCtx({});
      await triggerMediaMessage('message:photo', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:-1001234567890',
        expect.objectContaining({ content: '[Photo]' }),
      );
    });

    it('stores [Photo] with caption', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('fake-token', opts);
      await channel.connect();

      const ctx = makeMediaCtx({ caption: 'Look at this!' });
      await triggerMediaMessage('message:photo', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:-1001234567890',
        expect.objectContaining({ content: '[Photo] Look at this!' }),
      );
    });

    it('stores [Video] placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('fake-token', opts);
      await channel.connect();

      const ctx = makeMediaCtx({});
      await triggerMediaMessage('message:video', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:-1001234567890',
        expect.objectContaining({ content: '[Video]' }),
      );
    });

    it('stores [Voice message] placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('fake-token', opts);
      await channel.connect();

      const ctx = makeMediaCtx({});
      await triggerMediaMessage('message:voice', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:-1001234567890',
        expect.objectContaining({ content: '[Voice message]' }),
      );
    });

    it('stores [Audio] placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('fake-token', opts);
      await channel.connect();

      const ctx = makeMediaCtx({});
      await triggerMediaMessage('message:audio', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:-1001234567890',
        expect.objectContaining({ content: '[Audio]' }),
      );
    });

    it('stores [Document: filename] placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('fake-token', opts);
      await channel.connect();

      const ctx = makeMediaCtx({ extra: { document: { file_name: 'report.pdf' } } });
      await triggerMediaMessage('message:document', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:-1001234567890',
        expect.objectContaining({ content: '[Document: report.pdf]' }),
      );
    });

    it('stores [Sticker emoji] placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('fake-token', opts);
      await channel.connect();

      const ctx = makeMediaCtx({ extra: { sticker: { emoji: '😂' } } });
      await triggerMediaMessage('message:sticker', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:-1001234567890',
        expect.objectContaining({ content: '[Sticker 😂]' }),
      );
    });

    it('stores [Location] placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('fake-token', opts);
      await channel.connect();

      const ctx = makeMediaCtx({});
      await triggerMediaMessage('message:location', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:-1001234567890',
        expect.objectContaining({ content: '[Location]' }),
      );
    });

    it('stores [Contact] placeholder', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('fake-token', opts);
      await channel.connect();

      const ctx = makeMediaCtx({});
      await triggerMediaMessage('message:contact', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:-1001234567890',
        expect.objectContaining({ content: '[Contact]' }),
      );
    });

    it('ignores non-text from unregistered chats', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('fake-token', opts);
      await channel.connect();

      const ctx = makeMediaCtx({ chatId: 999999 });
      await triggerMediaMessage('message:photo', ctx);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // --- Sending messages ---

  describe('sendMessage', () => {
    it('sends message to correct chat', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('fake-token', opts);
      await channel.connect();

      await channel.sendMessage('tg:-1001234567890', 'Hello group!');

      expect(fakeApi.sendMessage).toHaveBeenCalledWith('-1001234567890', 'Hello group!');
    });

    it('strips tg: prefix from JID', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('fake-token', opts);
      await channel.connect();

      await channel.sendMessage('tg:123456', 'Hello DM!');

      expect(fakeApi.sendMessage).toHaveBeenCalledWith('123456', 'Hello DM!');
    });

    it('splits long messages at 4096 char boundary', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('fake-token', opts);
      await channel.connect();

      const longText = 'A'.repeat(5000);
      await channel.sendMessage('tg:123', longText);

      expect(fakeApi.sendMessage).toHaveBeenCalledTimes(2);
      expect(fakeApi.sendMessage).toHaveBeenNthCalledWith(1, '123', 'A'.repeat(4096));
      expect(fakeApi.sendMessage).toHaveBeenNthCalledWith(2, '123', 'A'.repeat(904));
    });

    it('sends short messages as single call', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('fake-token', opts);
      await channel.connect();

      await channel.sendMessage('tg:123', 'Short');

      expect(fakeApi.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('handles send failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('fake-token', opts);
      await channel.connect();

      fakeApi.sendMessage.mockRejectedValueOnce(new Error('Network error'));

      // Should not throw
      await expect(channel.sendMessage('tg:123', 'Will fail')).resolves.toBeUndefined();
    });

    it('warns when bot not initialized', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('fake-token', opts);
      // Don't connect

      await channel.sendMessage('tg:123', 'No bot');

      expect(fakeApi.sendMessage).not.toHaveBeenCalled();
    });
  });

  // --- JID ownership ---

  describe('ownsJid', () => {
    it('owns tg: JIDs', () => {
      const channel = new TelegramChannel('fake-token', createTestOpts());
      expect(channel.ownsJid('tg:123456')).toBe(true);
    });

    it('owns negative tg: JIDs (groups)', () => {
      const channel = new TelegramChannel('fake-token', createTestOpts());
      expect(channel.ownsJid('tg:-1001234567890')).toBe(true);
    });

    it('does not own WhatsApp JIDs', () => {
      const channel = new TelegramChannel('fake-token', createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own @s.whatsapp.net JIDs', () => {
      const channel = new TelegramChannel('fake-token', createTestOpts());
      expect(channel.ownsJid('12345@s.whatsapp.net')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new TelegramChannel('fake-token', createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- Typing indicator ---

  describe('setTyping', () => {
    it('sends typing action when isTyping is true', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('fake-token', opts);
      await channel.connect();

      await channel.setTyping('tg:-1001234567890', true);

      expect(fakeApi.sendChatAction).toHaveBeenCalledWith('-1001234567890', 'typing');
    });

    it('does nothing when isTyping is false', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('fake-token', opts);
      await channel.connect();

      await channel.setTyping('tg:-1001234567890', false);

      expect(fakeApi.sendChatAction).not.toHaveBeenCalled();
    });

    it('does nothing when bot not initialized', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('fake-token', opts);
      // Don't connect

      await channel.setTyping('tg:123', true);

      expect(fakeApi.sendChatAction).not.toHaveBeenCalled();
    });

    it('handles typing indicator failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('fake-token', opts);
      await channel.connect();

      fakeApi.sendChatAction.mockRejectedValueOnce(new Error('Failed'));

      await expect(channel.setTyping('tg:123', true)).resolves.toBeUndefined();
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "telegram"', () => {
      const channel = new TelegramChannel('fake-token', createTestOpts());
      expect(channel.name).toBe('telegram');
    });

    it('does not prefix assistant name', () => {
      const channel = new TelegramChannel('fake-token', createTestOpts());
      expect(channel.prefixAssistantName).toBe(false);
    });
  });

  // --- Error handling ---

  describe('error handling', () => {
    it('registers an error handler', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('fake-token', opts);
      await channel.connect();

      expect(errorHandler).not.toBeNull();
    });
  });
});
