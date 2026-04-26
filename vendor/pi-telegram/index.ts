import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";

import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

interface TelegramConfig {
	botToken?: string;
	botId?: number;
	botUsername?: string;
	lastUpdateId?: number;
	allowedUserId?: number;
	allowedChatIds?: number[];
}

interface TelegramUser {
	id: number;
	is_bot?: boolean;
	username?: string;
	first_name?: string;
	last_name?: string;
}

interface TelegramChat {
	id: number;
	type: string;
	title?: string;
	username?: string;
	first_name?: string;
	last_name?: string;
}

interface TelegramPhotoSize {
	file_id: string;
	file_unique_id: string;
	width: number;
	height: number;
	file_size?: number;
}

interface TelegramDocument {
	file_id: string;
	file_unique_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

interface TelegramMessage {
	message_id: number;
	date: number;
	text?: string;
	caption?: string;
	from?: TelegramUser;
	chat: TelegramChat;
	reply_to_message?: {
		from?: TelegramUser;
	};
	photo?: TelegramPhotoSize[];
	document?: TelegramDocument;
}

interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
	edited_message?: TelegramMessage;
}

interface TelegramApiResponse<T> {
	ok: boolean;
	result?: T;
	description?: string;
}

interface TelegramGetFileResult {
	file_path: string;
}

interface TelegramSentMessage {
	message_id: number;
}

interface PendingTelegramTurn {
	chatId: number;
	replyToMessageId: number;
	content: Array<TextContent | ImageContent>;
	queuedAttachments: QueuedAttachment[];
}

interface QueuedAttachment {
	path: string;
	fileName: string;
}

const CONFIG_PATH = join(homedir(), ".pi", "agent", "telegram.json");
const TEMP_DIR = join(homedir(), ".pi", "agent", "tmp", "telegram");
const TELEGRAM_PREFIX = "[telegram]";
const MAX_MESSAGE_LENGTH = 4096;
const MAX_ATTACHMENTS_PER_TURN = 10;
const LONG_POLL_TIMEOUT_SECONDS = 30;
const TYPING_INTERVAL_MS = 4000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function sanitizeFileName(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "file";
}

function isImagePath(path: string): boolean {
	return [".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(extname(path).toLowerCase());
}

function guessMimeType(path: string): string {
	switch (extname(path).toLowerCase()) {
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".png":
			return "image/png";
		case ".gif":
			return "image/gif";
		case ".webp":
			return "image/webp";
		case ".pdf":
			return "application/pdf";
		case ".txt":
			return "text/plain";
		case ".md":
			return "text/markdown";
		default:
			return "application/octet-stream";
	}
}

function chunkText(text: string): string[] {
	const trimmed = text.trim();
	if (!trimmed) return [];
	const chunks: string[] = [];
	let remaining = trimmed;
	while (remaining.length > MAX_MESSAGE_LENGTH) {
		let splitAt = remaining.lastIndexOf("\n\n", MAX_MESSAGE_LENGTH);
		if (splitAt < MAX_MESSAGE_LENGTH / 2) splitAt = remaining.lastIndexOf("\n", MAX_MESSAGE_LENGTH);
		if (splitAt < MAX_MESSAGE_LENGTH / 2) splitAt = remaining.lastIndexOf(" ", MAX_MESSAGE_LENGTH);
		if (splitAt <= 0) splitAt = MAX_MESSAGE_LENGTH;
		chunks.push(remaining.slice(0, splitAt).trim());
		remaining = remaining.slice(splitAt).trim();
	}
	if (remaining) chunks.push(remaining);
	return chunks.filter(Boolean);
}

function assistantTextFromMessage(message: AgentMessage | undefined): string {
	if (!message || (message as { role?: string }).role !== "assistant") return "";
	const value = message as { content?: Array<{ type?: string; text?: string }> };
	return (value.content || [])
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string)
		.join("")
		.trim();
}

function getLastAssistantMessage(messages: AgentMessage[]): AgentMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i] as { role?: string };
		if (message.role === "assistant") return messages[i];
	}
	return undefined;
}

async function readConfig(): Promise<TelegramConfig> {
	try {
		const content = await readFile(CONFIG_PATH, "utf8");
		return JSON.parse(content) as TelegramConfig;
	} catch {
		return {};
	}
}

async function writeConfig(config: TelegramConfig): Promise<void> {
	await mkdir(join(homedir(), ".pi", "agent"), { recursive: true });
	await writeFile(CONFIG_PATH, JSON.stringify(config, null, "\t") + "\n", "utf8");
}

export default function telegramExtension(pi: ExtensionAPI) {
	let config: TelegramConfig = {};
	let currentCtx: ExtensionContext | undefined;
	let pollingAbort: AbortController | undefined;
	let pollingPromise: Promise<void> | undefined;
	let pollingError: string | undefined;
	let queuedTurns: PendingTelegramTurn[] = [];
	let activeTurn: PendingTelegramTurn | undefined;
	let typingInterval: ReturnType<typeof setInterval> | undefined;

	function isGroupChat(chat: TelegramChat): boolean {
		return chat.type === "group" || chat.type === "supergroup";
	}

	function mentionsBot(text: string | undefined): boolean {
		if (!text || !config.botUsername) return false;
		return text.toLowerCase().includes(`@${config.botUsername.toLowerCase()}`);
	}

	function isReplyToBot(message: TelegramMessage): boolean {
		return !!(config.botId && message.reply_to_message?.from?.id === config.botId);
	}

	function shouldProcessChatMessage(message: TelegramMessage): boolean {
		if (!isGroupChat(message.chat)) return true;
		return mentionsBot(message.text) || mentionsBot(message.caption) || isReplyToBot(message);
	}

	function getMessageCommand(message: TelegramMessage): string | undefined {
		const text = (message.text || message.caption || "").trim();
		if (!text.startsWith("/")) return undefined;
		const token = text.split(/\s+/, 1)[0];
		const [command, target] = token.split("@", 2);
		if (!target) return command;
		if (!config.botUsername) return undefined;
		return target.toLowerCase() === config.botUsername.toLowerCase() ? command : undefined;
	}

	function updateStatus(ctx?: ExtensionContext): void {
		const runtimeCtx = ctx ?? currentCtx;
		if (!runtimeCtx?.hasUI) return;
		const theme = runtimeCtx.ui.theme;
		const label = theme.fg("accent", "telegram");
		if (pollingError) {
			runtimeCtx.ui.setStatus("telegram", `${label} ${theme.fg("error", "error")} ${theme.fg("muted", pollingError)}`);
			return;
		}
		if (!config.botToken) {
			runtimeCtx.ui.setStatus("telegram", `${label} ${theme.fg("muted", "missing bot token")}`);
			return;
		}
		const bot = config.botUsername ? theme.fg("muted", `@${config.botUsername}`) : theme.fg("muted", "bot ?");
		const pairing = config.allowedUserId
			? theme.fg("success", `user:${config.allowedUserId}`)
			: theme.fg("warning", "awaiting pairing");
		const chats = config.allowedChatIds?.length ? config.allowedChatIds.join(",") : "none";
		const queueText = queuedTurns.length > 0 ? theme.fg("muted", ` queue:${queuedTurns.length}`) : "";
		const state = pollingPromise ? theme.fg("success", "connected") : theme.fg("muted", "stopped");
		runtimeCtx.ui.setStatus("telegram", `${label} ${state} ${bot} ${pairing} ${theme.fg("muted", `chats:${chats}`)}${queueText}`);
	}

	async function callTelegram<TResponse>(
		method: string,
		body: Record<string, unknown>,
		options?: { signal?: AbortSignal },
	): Promise<TResponse> {
		if (!config.botToken) throw new Error("Telegram bot token is not configured");
		const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: options?.signal,
		});
		const data = (await response.json()) as TelegramApiResponse<TResponse>;
		if (!data.ok || data.result === undefined) {
			throw new Error(data.description || `Telegram API ${method} failed`);
		}
		return data.result;
	}

	async function callTelegramMultipart<TResponse>(
		method: string,
		fields: Record<string, string>,
		fileField: string,
		filePath: string,
		fileName: string,
		options?: { signal?: AbortSignal },
	): Promise<TResponse> {
		if (!config.botToken) throw new Error("Telegram bot token is not configured");
		const form = new FormData();
		for (const [key, value] of Object.entries(fields)) form.set(key, value);
		const buffer = await readFile(filePath);
		form.set(fileField, new Blob([buffer]), fileName);
		const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
			method: "POST",
			body: form,
			signal: options?.signal,
		});
		const data = (await response.json()) as TelegramApiResponse<TResponse>;
		if (!data.ok || data.result === undefined) {
			throw new Error(data.description || `Telegram API ${method} failed`);
		}
		return data.result;
	}

	async function downloadTelegramFile(fileId: string, suggestedName: string): Promise<string> {
		if (!config.botToken) throw new Error("Telegram bot token is not configured");
		const file = await callTelegram<TelegramGetFileResult>("getFile", { file_id: fileId });
		await mkdir(TEMP_DIR, { recursive: true });
		const targetPath = join(TEMP_DIR, `${Date.now()}-${sanitizeFileName(suggestedName)}`);
		const response = await fetch(`https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`);
		if (!response.ok) throw new Error(`Failed to download Telegram file: ${response.status}`);
		const arrayBuffer = await response.arrayBuffer();
		await writeFile(targetPath, Buffer.from(arrayBuffer));
		return targetPath;
	}

	function startTyping(chatId: number): void {
		if (typingInterval) return;
		const tick = async (): Promise<void> => {
			try {
				await callTelegram("sendChatAction", { chat_id: chatId, action: "typing" });
			} catch {
				// ignore transient typing errors
			}
		};
		void tick();
		typingInterval = setInterval(() => {
			void tick();
		}, TYPING_INTERVAL_MS);
	}

	function stopTyping(): void {
		if (!typingInterval) return;
		clearInterval(typingInterval);
		typingInterval = undefined;
	}

	async function sendTextReply(chatId: number, replyToMessageId: number | undefined, text: string): Promise<void> {
		const chunks = chunkText(text);
		let first = true;
		for (const chunk of chunks) {
			await callTelegram<TelegramSentMessage>("sendMessage", {
				chat_id: chatId,
				text: chunk,
				...(first && replyToMessageId !== undefined ? { reply_to_message_id: replyToMessageId } : {}),
			});
			first = false;
		}
	}

	async function sendQueuedAttachments(turn: PendingTelegramTurn): Promise<void> {
		let first = true;
		for (const attachment of turn.queuedAttachments) {
			const reply = first ? turn.replyToMessageId : undefined;
			const fields = {
				chat_id: String(turn.chatId),
				...(reply !== undefined ? { reply_to_message_id: String(reply) } : {}),
			};
			if (isImagePath(attachment.path)) {
				await callTelegramMultipart("sendPhoto", fields, "photo", attachment.path, attachment.fileName);
			} else {
				await callTelegramMultipart("sendDocument", fields, "document", attachment.path, attachment.fileName);
			}
			first = false;
		}
	}

	async function ensureBotInfo(): Promise<void> {
		if (!config.botToken) return;
		try {
			const me = await callTelegram<{ id: number; username?: string }>("getMe", {});
			config.botId = me.id;
			config.botUsername = me.username;
			await writeConfig(config);
		} catch {
			// Keep existing config if validation fails; polling will surface the error.
		}
	}

	function isAllowedMessage(message: TelegramMessage): boolean {
		const fromId = message.from?.id;
		if (!fromId || message.from?.is_bot) return false;
		if (!config.allowedUserId) return true;
		if (fromId !== config.allowedUserId) return false;
		if (!config.allowedChatIds || config.allowedChatIds.length === 0) return true;
		return config.allowedChatIds.includes(message.chat.id);
	}

	async function pairFromMessage(message: TelegramMessage): Promise<void> {
		if (!message.from?.id) return;
		if (!config.allowedUserId) {
			config.allowedUserId = message.from.id;
		}
		const chatIds = new Set(config.allowedChatIds || []);
		chatIds.add(message.chat.id);
		config.allowedChatIds = [...chatIds];
		await writeConfig(config);
	}

	async function buildTurn(message: TelegramMessage): Promise<PendingTelegramTurn | undefined> {
		const text = (message.text || message.caption || "").trim();
		const content: Array<TextContent | ImageContent> = [];
		const extraLines: string[] = [];

		if (message.photo?.length) {
			const photo = [...message.photo].sort((a, b) => (a.file_size || 0) - (b.file_size || 0)).at(-1);
			if (photo) {
				const filePath = await downloadTelegramFile(photo.file_id, `${photo.file_unique_id}.jpg`);
				const buffer = await readFile(filePath);
				content.push({ type: "image", data: buffer.toString("base64"), mimeType: "image/jpeg" });
				extraLines.push(`Telegram image saved at ${filePath}`);
			}
		}

		if (message.document) {
			const fileName = message.document.file_name || `${message.document.file_unique_id}${extname(message.document.file_name || "")}` || "document";
			const filePath = await downloadTelegramFile(message.document.file_id, fileName);
			if ((message.document.mime_type || "").startsWith("image/") || isImagePath(filePath)) {
				const buffer = await readFile(filePath);
				content.push({
					type: "image",
					data: buffer.toString("base64"),
					mimeType: message.document.mime_type || guessMimeType(filePath),
				});
			} else {
				extraLines.push(`Telegram attachment saved at ${filePath}`);
			}
		}

		const headerParts = [TELEGRAM_PREFIX];
		if (message.from?.username) headerParts.push(`from @${message.from.username}`);
		const header = headerParts.join(" ");
		const textLines = [header];
		if (text) textLines.push("", text);
		if (extraLines.length > 0) textLines.push("", ...extraLines);
		content.unshift({ type: "text", text: textLines.join("\n") });

		if (content.length === 1 && !text && extraLines.length === 0) {
			return undefined;
		}

		return {
			chatId: message.chat.id,
			replyToMessageId: message.message_id,
			content,
			queuedAttachments: [],
		};
	}

	function maybeDispatchNext(): void {
		if (activeTurn || queuedTurns.length === 0) {
			updateStatus();
			return;
		}
		if (currentCtx && !currentCtx.isIdle()) {
			updateStatus();
			return;
		}
		const nextTurn = queuedTurns.shift();
		if (!nextTurn) {
			updateStatus();
			return;
		}
		activeTurn = nextTurn;
		startTyping(nextTurn.chatId);
		updateStatus();
		pi.sendUserMessage(nextTurn.content);
	}

	async function processTelegramMessage(message: TelegramMessage): Promise<void> {
		if (!message.from?.id || message.from.is_bot) return;
		if (!shouldProcessChatMessage(message)) return;
		const command = getMessageCommand(message);
		if (!config.allowedUserId) {
			await pairFromMessage(message);
			await callTelegram("sendMessage", {
				chat_id: message.chat.id,
				text: `Connected to pi as @${config.botUsername || "bot"}. In groups, I'll only respond when mentioned${config.botUsername ? ` as @${config.botUsername}` : ""}.`,
				reply_to_message_id: message.message_id,
			});
			updateStatus();
			if (command === "/start") return;
		}
		if (!isAllowedMessage(message)) return;
		if (config.allowedUserId === message.from.id && !config.allowedChatIds?.includes(message.chat.id)) {
			await pairFromMessage(message);
		}
		if (command && ["/start", "/telegram-connect", "/help"].includes(command)) {
			await callTelegram("sendMessage", {
				chat_id: message.chat.id,
				text: `pi telegram bridge is connected${config.botUsername ? ` via @${config.botUsername}` : ""}. Mention me in a group, or send any message in a private chat, to talk to pi.`,
				reply_to_message_id: message.message_id,
			});
			return;
		}
		const turn = await buildTurn(message);
		if (!turn) {
			await callTelegram("sendMessage", {
				chat_id: message.chat.id,
				text: "I could not extract any text or supported attachments from that message.",
				reply_to_message_id: message.message_id,
			});
			return;
		}
		queuedTurns.push(turn);
		updateStatus();
		maybeDispatchNext();
	}

	async function handleUpdates(updates: TelegramUpdate[]): Promise<void> {
		for (const update of updates) {
			config.lastUpdateId = update.update_id;
			const message = update.message || update.edited_message;
			if (message) await processTelegramMessage(message);
		}
		await writeConfig(config);
	}

	async function pollLoop(): Promise<void> {
		while (pollingAbort && !pollingAbort.signal.aborted) {
			try {
				const updates = await callTelegram<TelegramUpdate[]>(
					"getUpdates",
					{
						offset: (config.lastUpdateId || 0) + 1,
						timeout: LONG_POLL_TIMEOUT_SECONDS,
						allowed_updates: ["message", "edited_message"],
					},
					{ signal: pollingAbort.signal },
				);
				pollingError = undefined;
				if (updates.length > 0) await handleUpdates(updates);
				updateStatus();
			} catch (error) {
				if (pollingAbort?.signal.aborted) return;
				pollingError = error instanceof Error ? error.message : String(error);
				updateStatus();
				await sleep(5000);
			}
		}
	}

	async function startPolling(): Promise<void> {
		if (pollingPromise) return;
		if (!config.botToken) throw new Error(`Missing bot token in ${CONFIG_PATH}`);
		await ensureBotInfo();
		pollingAbort = new AbortController();
		pollingError = undefined;
		pollingPromise = pollLoop().finally(() => {
			pollingAbort = undefined;
			pollingPromise = undefined;
			updateStatus();
		});
		updateStatus();
	}

	async function stopPolling(): Promise<void> {
		pollingAbort?.abort();
		if (pollingPromise) {
			try {
				await pollingPromise;
			} catch {
				// ignore shutdown errors
			}
		}
		pollingAbort = undefined;
		pollingPromise = undefined;
		updateStatus();
	}

	const telegramAttachTool = defineTool({
		name: "telegram_attach",
		label: "Telegram Attach",
		description: "Queue one or more local files to be sent back to the Telegram chat after the final response. Use this when the Telegram user asked for a file or generated artifact.",
		parameters: Type.Object({
			paths: Type.Array(Type.String({ description: "Absolute or relative local file path" }), {
				minItems: 1,
				maxItems: MAX_ATTACHMENTS_PER_TURN,
				description: "Local file paths to send to Telegram",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!activeTurn) {
				return {
					content: [{ type: "text", text: "telegram_attach can only be used while replying to an active Telegram message." }],
					details: { queued: 0 },
				};
			}
			const queued: QueuedAttachment[] = [];
			for (const rawPath of params.paths) {
				const resolvedPath = resolve(ctx.cwd, rawPath);
				const info = await stat(resolvedPath);
				if (!info.isFile()) {
					throw new Error(`Not a file: ${rawPath}`);
				}
				queued.push({ path: resolvedPath, fileName: sanitizeFileName(rawPath.split("/").at(-1) || "file") });
			}
			activeTurn.queuedAttachments.push(...queued);
			if (activeTurn.queuedAttachments.length > MAX_ATTACHMENTS_PER_TURN) {
				activeTurn.queuedAttachments = activeTurn.queuedAttachments.slice(0, MAX_ATTACHMENTS_PER_TURN);
			}
			return {
				content: [{ type: "text", text: `Queued ${queued.length} Telegram attachment(s).` }],
				details: { queued: queued.map((item) => item.path) },
			};
		},
	});

	pi.registerTool(telegramAttachTool);

	pi.registerCommand("telegram-connect", {
		description: "Start Telegram polling and show bridge status",
		handler: async (_args, ctx) => {
			currentCtx = ctx;
			config = await readConfig();
			if (!config.botToken) {
				ctx.ui.notify(`Missing Telegram bot token in ${CONFIG_PATH}`, "warning");
				updateStatus(ctx);
				return;
			}
			await startPolling();
			updateStatus(ctx);
			const text = config.allowedUserId
				? `Telegram bridge connected as @${config.botUsername || "bot"}. Allowed user: ${config.allowedUserId}. Allowed chats: ${config.allowedChatIds?.join(", ") || "none"}.`
				: `Telegram bridge connected as @${config.botUsername || "bot"}. Send /start to the bot from the Telegram account/chat you want to pair.`;
			ctx.ui.notify(text, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		config = await readConfig();
		updateStatus(ctx);
		if (config.botToken) {
			try {
				await startPolling();
			} catch (error) {
				pollingError = error instanceof Error ? error.message : String(error);
				updateStatus(ctx);
			}
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		currentCtx = ctx;
		stopTyping();
		if (!activeTurn) {
			maybeDispatchNext();
			return;
		}
		const turn = activeTurn;
		activeTurn = undefined;
		try {
			const assistant = getLastAssistantMessage(event.messages) as { stopReason?: string; errorMessage?: string } | undefined;
			const stopReason = assistant?.stopReason;
			if (stopReason === "aborted") {
				await callTelegram("sendMessage", {
					chat_id: turn.chatId,
					text: "Request aborted.",
					reply_to_message_id: turn.replyToMessageId,
				});
			} else if (stopReason === "error") {
				await callTelegram("sendMessage", {
					chat_id: turn.chatId,
					text: assistant?.errorMessage || "pi failed while processing the Telegram request.",
					reply_to_message_id: turn.replyToMessageId,
				});
			} else {
				const finalText = assistantTextFromMessage(assistant as AgentMessage | undefined);
				if (finalText) {
					await sendTextReply(turn.chatId, turn.replyToMessageId, finalText);
				} else if (turn.queuedAttachments.length > 0) {
					await sendTextReply(turn.chatId, turn.replyToMessageId, "Attached requested file(s).");
				} else {
					await sendTextReply(turn.chatId, turn.replyToMessageId, "Done.");
				}
				if (turn.queuedAttachments.length > 0) {
					await sendQueuedAttachments(turn);
				}
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			try {
				await callTelegram("sendMessage", {
					chat_id: turn.chatId,
					text: `Telegram bridge error: ${message}`,
					reply_to_message_id: turn.replyToMessageId,
				});
			} catch {
				// nothing left to do
			}
		}
		updateStatus(ctx);
		maybeDispatchNext();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		currentCtx = ctx;
		queuedTurns = [];
		activeTurn = undefined;
		stopTyping();
		await stopPolling();
	});
}
