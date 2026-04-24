import "dotenv/config";

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Bot } from "grammy";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@mariozechner/pi-coding-agent";

type ChatIndex = Record<string, string>;
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type ToolMode = "readonly" | "coding";

const TELEGRAM_MESSAGE_LIMIT = 4000;
const VALID_THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

function parseAllowedChatIds(value: string | undefined): Set<string> {
  if (!value?.trim()) return new Set();
  return new Set(
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function parseThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
  if (!value) return undefined;
  if (VALID_THINKING_LEVELS.has(value as ThinkingLevel)) return value as ThinkingLevel;
  throw new Error(`Invalid PI_THINKING_LEVEL: ${value}`);
}

function parseToolMode(value: string | undefined): ToolMode {
  return value === "coding" ? "coding" : "readonly";
}

function splitTelegramMessage(text: string, limit = TELEGRAM_MESSAGE_LIMIT): string[] {
  const normalized = text.trim();
  if (!normalized) return ["(no text response)"];
  if (normalized.length <= limit) return [normalized];

  const chunks: string[] = [];
  let remaining = normalized;

  while (remaining.length > limit) {
    const slice = remaining.slice(0, limit);
    const splitAt = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf("\n"), slice.lastIndexOf(" "));
    const cut = splitAt > Math.floor(limit * 0.6) ? splitAt : limit;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

function extractTextParts(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (
      part &&
      typeof part === "object" &&
      "type" in part &&
      part.type === "text" &&
      "text" in part &&
      typeof part.text === "string"
    ) {
      return [part.text];
    }
    return [];
  });
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

class PiTelegramBridge {
  private readonly cwd: string;
  private readonly agentDir: string;
  private readonly stateDir: string;
  private readonly indexFile: string;
  private readonly allowedChatIds: Set<string>;
  private readonly allowGroups: boolean;
  private readonly thinkingLevel?: ThinkingLevel;
  private readonly toolMode: ToolMode;
  private readonly modelSelector?: string;

  private readonly authStorage: AuthStorage;
  private readonly modelRegistry: ModelRegistry;
  private readonly settingsManager: SettingsManager;
  private readonly resourceLoader: DefaultResourceLoader;

  private readonly sessions = new Map<string, AgentSession>();
  private readonly queues = new Map<string, Promise<void>>();
  private chatIndex: ChatIndex = {};

  constructor() {
    this.cwd = path.resolve(expandHome(process.env.PI_CWD ?? process.cwd()));
    this.agentDir = expandHome(process.env.PI_AGENT_DIR ?? getAgentDir());
    this.stateDir = path.resolve(expandHome(process.env.STATE_DIR ?? path.join(this.cwd, ".data", "telegram-pi")));
    this.indexFile = path.join(this.stateDir, "chat-sessions.json");
    this.allowedChatIds = parseAllowedChatIds(process.env.TELEGRAM_ALLOWED_CHAT_IDS);
    this.allowGroups = process.env.TELEGRAM_ALLOW_GROUPS === "true";
    this.thinkingLevel = parseThinkingLevel(process.env.PI_THINKING_LEVEL ?? "off");
    this.toolMode = parseToolMode(process.env.PI_TOOL_MODE);
    this.modelSelector = process.env.PI_MODEL?.trim() || undefined;

    this.authStorage = AuthStorage.create(path.join(this.agentDir, "auth.json"));
    this.modelRegistry = ModelRegistry.create(this.authStorage, path.join(this.agentDir, "models.json"));
    this.settingsManager = SettingsManager.create(this.cwd, this.agentDir);
    this.resourceLoader = new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: this.agentDir,
      settingsManager: this.settingsManager,
    });
  }

  async init(): Promise<void> {
    await ensureDir(this.stateDir);
    await this.loadIndex();
    await this.resourceLoader.reload();
  }

  isChatAllowed(chatId: number | string, chatType: string): boolean {
    if (chatType !== "private" && !this.allowGroups) return false;
    if (this.allowedChatIds.size === 0) return true;
    return this.allowedChatIds.has(String(chatId));
  }

  getCwd(): string {
    return this.cwd;
  }

  async resetChat(chatId: string): Promise<void> {
    const existing = this.sessions.get(chatId);
    existing?.dispose();
    this.sessions.delete(chatId);
    delete this.chatIndex[chatId];
    await this.saveIndex();
  }

  getSessionFile(chatId: string): string | undefined {
    return this.sessions.get(chatId)?.sessionFile ?? this.chatIndex[chatId];
  }

  enqueue(chatId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(chatId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(work)
      .finally(() => {
        if (this.queues.get(chatId) === next) {
          this.queues.delete(chatId);
        }
      });

    this.queues.set(chatId, next);
    return next;
  }

  async prompt(chatId: string, text: string): Promise<string> {
    const session = await this.getOrCreateSession(chatId);
    const beforeCount = session.messages.length;
    await session.prompt(text);

    const assistantMessages = session.messages
      .slice(beforeCount)
      .filter((message) => message.role === "assistant");

    const response = assistantMessages
      .flatMap((message) => extractTextParts(message.content))
      .join("\n\n")
      .trim();

    return response || "(no text response)";
  }

  async shutdown(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
    await this.settingsManager.flush();
  }

  private async loadIndex(): Promise<void> {
    try {
      const raw = await fs.readFile(this.indexFile, "utf8");
      this.chatIndex = JSON.parse(raw) as ChatIndex;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
      this.chatIndex = {};
    }
  }

  private async saveIndex(): Promise<void> {
    await ensureDir(this.stateDir);
    await fs.writeFile(this.indexFile, `${JSON.stringify(this.chatIndex, null, 2)}\n`, "utf8");
  }

  private async getOrCreateSession(chatId: string): Promise<AgentSession> {
    const existing = this.sessions.get(chatId);
    if (existing) return existing;

    const sessionFile = this.chatIndex[chatId];
    const sessionManager = sessionFile ? SessionManager.open(sessionFile) : SessionManager.create(this.cwd);
    const model = await this.resolveModel();

    const { session } = await createAgentSession({
      cwd: this.cwd,
      agentDir: this.agentDir,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      settingsManager: this.settingsManager,
      resourceLoader: this.resourceLoader,
      sessionManager,
      model,
      thinkingLevel: this.thinkingLevel,
      tools: this.toolMode === "coding" ? ["read", "bash", "edit", "write"] : ["read", "grep", "find", "ls"],
    });

    this.sessions.set(chatId, session);

    if (session.sessionFile && this.chatIndex[chatId] !== session.sessionFile) {
      this.chatIndex[chatId] = session.sessionFile;
      await this.saveIndex();
    }

    return session;
  }

  private async resolveModel() {
    if (!this.modelSelector) return undefined;

    const [provider, ...rest] = this.modelSelector.split("/");
    const id = rest.join("/");
    if (!provider || !id) {
      throw new Error(`PI_MODEL must be in provider/model form, got: ${this.modelSelector}`);
    }

    const model = this.modelRegistry.find(provider, id);
    if (!model) {
      const available = (await this.modelRegistry.getAvailable())
        .map((entry) => `${entry.provider}/${entry.id}`)
        .sort();
      throw new Error(
        `Could not find model ${this.modelSelector}. Available models: ${available.join(", ") || "none"}`,
      );
    }

    return model;
  }
}

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  throw new Error("Missing TELEGRAM_BOT_TOKEN");
}

const bridge = new PiTelegramBridge();
await bridge.init();

const bot = new Bot(token);

async function sendText(chatId: number, text: string): Promise<void> {
  const parts = splitTelegramMessage(text);
  for (const part of parts) {
    await bot.api.sendMessage(chatId, part);
  }
}

async function handlePrompt(chatId: number, text: string): Promise<void> {
  const pending = await bot.api.sendMessage(chatId, "Thinking…");

  try {
    const reply = await bridge.prompt(String(chatId), text);
    const parts = splitTelegramMessage(reply);

    await bot.api.editMessageText(chatId, pending.message_id, parts[0]);
    for (const extra of parts.slice(1)) {
      await bot.api.sendMessage(chatId, extra);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await bot.api.editMessageText(chatId, pending.message_id, `Error: ${message}`);
  }
}

function rejectAccess(chatId: number, chatType: string): Promise<void> {
  console.warn(`Rejected Telegram chat ${chatId} (${chatType})`);
  return sendText(chatId, "Access denied for this chat.");
}

bot.command("start", async (ctx) => {
  const chat = ctx.chat;
  if (!chat) return;
  if (!bridge.isChatAllowed(chat.id, chat.type)) {
    await rejectAccess(chat.id, chat.type);
    return;
  }

  await sendText(
    chat.id,
    [
      "Hi. I am a pi-backed Telegram bot.",
      "",
      "Send a message to start a session.",
      "Commands: /help, /reset, /session",
    ].join("\n"),
  );
});

bot.command("help", async (ctx) => {
  const chat = ctx.chat;
  if (!chat) return;
  if (!bridge.isChatAllowed(chat.id, chat.type)) {
    await rejectAccess(chat.id, chat.type);
    return;
  }

  await sendText(
    chat.id,
    [
      "Commands:",
      "/start - intro",
      "/help - this help",
      "/reset - start a fresh session for this chat",
      "/session - show the current session file",
      "",
      "Every chat gets its own persistent pi session.",
    ].join("\n"),
  );
});

bot.command("reset", async (ctx) => {
  const chat = ctx.chat;
  if (!chat) return;
  if (!bridge.isChatAllowed(chat.id, chat.type)) {
    await rejectAccess(chat.id, chat.type);
    return;
  }

  await bridge.enqueue(String(chat.id), async () => {
    await bridge.resetChat(String(chat.id));
    await sendText(chat.id, "Started a fresh session for this chat.");
  });
});

bot.command("session", async (ctx) => {
  const chat = ctx.chat;
  if (!chat) return;
  if (!bridge.isChatAllowed(chat.id, chat.type)) {
    await rejectAccess(chat.id, chat.type);
    return;
  }

  const sessionFile = bridge.getSessionFile(String(chat.id));
  await sendText(chat.id, sessionFile ? `Session: ${sessionFile}` : "No session yet for this chat.");
});

bot.on("message:text", async (ctx) => {
  const chat = ctx.chat;
  const from = ctx.from;
  const text = ctx.message.text.trim();

  if (!chat || !from || !text || text.startsWith("/")) return;
  if (from.is_bot) return;

  if (!bridge.isChatAllowed(chat.id, chat.type)) {
    await rejectAccess(chat.id, chat.type);
    return;
  }

  await bridge.enqueue(String(chat.id), async () => {
    await handlePrompt(chat.id, text);
  });
});

bot.catch((error) => {
  console.error("Telegram bot error:", error.error);
});

const shutdown = async (signal: string) => {
  console.log(`Received ${signal}, shutting down...`);
  bot.stop();
  await bridge.shutdown();
  process.exit(0);
};

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

console.log(`Starting Telegram bot in ${bridge.getCwd()}`);
bot.start();
