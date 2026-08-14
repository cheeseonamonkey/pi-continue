/**
 * double-tap-continue
 *
 * When the prompt is empty and the agent is idle (e.g. you just hit Esc and
 * interrupted a turn by accident), double-tap Enter (configurable) to send a
 * "continue" message and resume the agent.
 *
 *   1st tap → ARMED  (a widget appears above the editor)
 *   2nd tap within the arm window → FIRED (the continue message is sent)
 *   any other key / timeout → disarmed
 *
 * How it works: pi does not allow extensions to override reserved built-in
 * shortcuts such as `tui.input.submit` (Enter) via `pi.registerShortcut()`.
 * Instead this extension installs a thin wrapper editor component via
 * `ctx.ui.setEditorComponent()`. The wrapper inspects each keypress BEFORE
 * the default editor sees it:
 *
 *   - configured key + empty prompt + agent idle → arm/fire logic, consumed
 *   - everything else → delegated to the stock editor unchanged
 *
 * Because delegation is literal `super.handleInput(data)`, ALL native
 * behavior (submit, slash commands, !bash, history, autocomplete, streaming
 * steer, …) is preserved byte-for-byte. There is no reimplemented submit.
 *
 * Configuration is layered (later layers override earlier ones):
 *
 *   1. `double-tap-continue.config.json` shipped with this package (defaults)
 *   2. `~/.pi/agent/double-tap-continue.json`                    (global user)
 *   3. `<project>/.pi/double-tap-continue.json`                  (project)
 *
 * All keys are optional. Run `/reload` in pi (or restart) to pick up changes.
 * Run `/double-tap-continue` in pi to see the effective configuration.
 *
 * Config keys:
 *   enabled                (boolean, default true)   master on/off switch
 *   shortcutKey            (string,  default "enter")
 *                          key used for the double-tap, e.g. "enter",
 *                          "ctrl+enter", "alt+enter". Unlike registerShortcut,
 *                          the editor-wrapper approach can safely use reserved
 *                          keys like "enter" because non-matching input is
 *                          delegated to the stock editor.
 *   armedWidgetText        (string,  default "Press Enter again to continue…")
 *                          widget text shown above the editor while armed
 *   armTimeoutMs           (number,  default 1500, clamped to 100–10000)
 *                          how long the arm window stays open
 *   continueMessage        (string,  default "(continue...)")
 *                          text sent to the agent when the double-tap fires
 *   rewindEmptyTurn        (boolean, default true)
 *                          fork from the most recent user message before
 *                          continuing when the subsequent agent output is tiny
 *   rewindMaxAssistantTokens (number, default 10, clamped to 0–1000)
 *                          maximum estimated assistant-output tokens allowed
 *                          for rewindEmptyTurn
 *   deleteMessageAfterSend (boolean, default false)
 *                          false → sent as a normal user message (chat bubble)
 *                          true  → sent silently: the message enters the LLM
 *                                  context and triggers the turn but never
 *                                  appears in the transcript. (pi has no API
 *                                  to delete a sent message, so "delete
 *                                  immediately" is implemented as "never
 *                                  show".)
 */

import {
	CustomEditor,
	estimateTokens,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, type EditorTheme, type KeyId, type TUI } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WIDGET_KEY = "double-tap-continue";
const CONFIG_FILENAME = "double-tap-continue.json";
const PACKAGE_CONFIG_FILENAME = "double-tap-continue.config.json";
const INTERNAL_FIRE_COMMAND = "__double-tap-continue-fire";

const MIN_ARM_TIMEOUT_MS = 100;
const MAX_ARM_TIMEOUT_MS = 10_000;
const MIN_REWIND_MAX_ASSISTANT_TOKENS = 0;
const MAX_REWIND_MAX_ASSISTANT_TOKENS = 1_000;

const TRACE = !!process.env.DTCTRACE;
const TRACE_FILE = process.env.DTCTRACE_FILE || "/tmp/dtc.log";

function trace(event: string, data?: unknown): void {
	if (!TRACE) return;
	try {
		const { appendFileSync } = require("node:fs");
		appendFileSync(TRACE_FILE, JSON.stringify({ ts: Date.now(), event, ...(data ? { data } : {}) }) + "\n");
	} catch {
		// best effort
	}
}

interface Config {
	enabled: boolean;
	shortcutKey: string;
	armedWidgetText: string;
	armTimeoutMs: number;
	continueMessage: string;
	rewindEmptyTurn: boolean;
	rewindMaxAssistantTokens: number;
	deleteMessageAfterSend: boolean;
}

const DEFAULTS: Config = {
	enabled: true,
	shortcutKey: "enter",
	armedWidgetText: "Press Enter again to continue…",
	armTimeoutMs: 1500,
	continueMessage: "(continue...)",
	rewindEmptyTurn: true,
	rewindMaxAssistantTokens: 10,
	deleteMessageAfterSend: false,
};

interface ConfigLayer {
	path: string;
	loaded: boolean;
}

interface LoadResult {
	config: Config;
	warnings: string[];
	layers: ConfigLayer[];
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function sanitize(raw: Record<string, unknown>, source: string, warnings: string[]): Partial<Config> {
	const out: Partial<Config> = {};

	if (raw.enabled !== undefined) {
		if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
		else warnings.push(`${source}: "enabled" should be a boolean, ignoring`);
	}
	if (raw.shortcutKey !== undefined) {
		if (typeof raw.shortcutKey === "string" && raw.shortcutKey.trim()) out.shortcutKey = raw.shortcutKey.trim();
		else warnings.push(`${source}: "shortcutKey" should be a non-empty string, ignoring`);
	}
	if (raw.armedWidgetText !== undefined) {
		if (typeof raw.armedWidgetText === "string" && raw.armedWidgetText.trim()) {
			out.armedWidgetText = raw.armedWidgetText;
		} else warnings.push(`${source}: "armedWidgetText" should be a non-empty string, ignoring`);
	}
	if (raw.armTimeoutMs !== undefined) {
		if (typeof raw.armTimeoutMs === "number" && Number.isFinite(raw.armTimeoutMs)) {
			const clamped = clamp(raw.armTimeoutMs, MIN_ARM_TIMEOUT_MS, MAX_ARM_TIMEOUT_MS);
			if (clamped !== raw.armTimeoutMs) {
				warnings.push(`${source}: "armTimeoutMs" clamped from ${raw.armTimeoutMs} to ${clamped}`);
			}
			out.armTimeoutMs = clamped;
		} else warnings.push(`${source}: "armTimeoutMs" should be a number, ignoring`);
	}
	if (raw.continueMessage !== undefined) {
		if (typeof raw.continueMessage === "string" && raw.continueMessage.trim()) {
			out.continueMessage = raw.continueMessage;
		} else warnings.push(`${source}: "continueMessage" should be a non-empty string, ignoring`);
	}
	if (raw.rewindEmptyTurn !== undefined) {
		if (typeof raw.rewindEmptyTurn === "boolean") out.rewindEmptyTurn = raw.rewindEmptyTurn;
		else warnings.push(`${source}: "rewindEmptyTurn" should be a boolean, ignoring`);
	}
	if (raw.rewindMaxAssistantTokens !== undefined) {
		if (typeof raw.rewindMaxAssistantTokens === "number" && Number.isFinite(raw.rewindMaxAssistantTokens)) {
			const clamped = clamp(
				Math.floor(raw.rewindMaxAssistantTokens),
				MIN_REWIND_MAX_ASSISTANT_TOKENS,
				MAX_REWIND_MAX_ASSISTANT_TOKENS,
			);
			if (clamped !== raw.rewindMaxAssistantTokens) {
				warnings.push(`${source}: "rewindMaxAssistantTokens" clamped from ${raw.rewindMaxAssistantTokens} to ${clamped}`);
			}
			out.rewindMaxAssistantTokens = clamped;
		} else warnings.push(`${source}: "rewindMaxAssistantTokens" should be a number, ignoring`);
	}
	if (raw.deleteMessageAfterSend !== undefined) {
		if (typeof raw.deleteMessageAfterSend === "boolean") out.deleteMessageAfterSend = raw.deleteMessageAfterSend;
		else warnings.push(`${source}: "deleteMessageAfterSend" should be a boolean, ignoring`);
	}

	return out;
}

function readLayer(path: string, warnings: string[]): Partial<Config> {
	try {
		if (!existsSync(path)) return {};
		const raw = JSON.parse(readFileSync(path, "utf8"));
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			warnings.push(`${path}: expected a JSON object, ignoring file`);
			return {};
		}
		return sanitize(raw as Record<string, unknown>, path, warnings);
	} catch (err) {
		warnings.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
		return {};
	}
}

function loadConfig(): LoadResult {
	const warnings: string[] = [];
	const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));

	const layerPaths = [
		join(packageDir, PACKAGE_CONFIG_FILENAME),
		join(homedir(), ".pi", "agent", CONFIG_FILENAME),
		join(process.cwd(), ".pi", CONFIG_FILENAME),
	];
	const layers = layerPaths.map((path) => readLayer(path, warnings));

	const config: Config = Object.assign({ ...DEFAULTS }, ...layers);
	return {
		config,
		warnings,
		layers: layerPaths.map((path) => ({ path, loaded: existsSync(path) })),
	};
}

/** Hooks the editor wrapper uses to talk back to the extension. */
interface EditorHooks {
	getConfig(): Config;
	getCtx(): ExtensionContext | undefined;
	isArmed(): boolean;
	arm(ctx: ExtensionContext): void;
	disarm(): void;
	fire(ctx: ExtensionContext): void;
}

class DoubleTapEditor extends CustomEditor {
	private hooks: EditorHooks;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, hooks: EditorHooks) {
		super(tui, theme, keybindings);
		this.hooks = hooks;
	}

	handleInput(data: string): void {
		const config = this.hooks.getConfig();
		const key = config.shortcutKey;
		const isShortcut = matchesKey(data, key as KeyId);

		if (isShortcut) {
			const ctx = this.hooks.getCtx();
			const inScope = ctx !== undefined && this.getText().trim().length === 0 && ctx.isIdle();
			trace("shortcut_pressed", { idle: ctx?.isIdle(), textLen: this.getText().length, inScope });

			if (inScope && ctx) {
				if (this.hooks.isArmed()) {
					this.hooks.fire(ctx);
				} else {
					this.hooks.arm(ctx);
				}
				return; // consume: in this state stock Enter is a no-op anyway
			}
		}

		// Any other key while armed cancels the arm, then behaves natively.
		if (this.hooks.isArmed() && !isShortcut) {
			this.hooks.disarm();
		}

		// Delegate everything else to the stock editor, byte-for-byte.
		super.handleInput(data);
	}
}

export default function (pi: ExtensionAPI) {
	const { config, warnings, layers } = loadConfig();

	let currentCtx: ExtensionContext | undefined;
	let armed = false;
	let armTimer: ReturnType<typeof setTimeout> | undefined;

	const disarm = () => {
		armed = false;
		if (armTimer) {
			clearTimeout(armTimer);
			armTimer = undefined;
		}
		try {
			currentCtx?.ui.setWidget(WIDGET_KEY, undefined);
		} catch {
			// ctx may be stale after /reload or session replacement; safe to ignore.
		}
	};

	const hooks: EditorHooks = {
		getConfig: () => config,
		getCtx: () => currentCtx,
		isArmed: () => armed,
		arm(ctx) {
			armed = true;
			ctx.ui.setWidget(WIDGET_KEY, [config.armedWidgetText]);
			armTimer = setTimeout(() => {
				trace("arm_timeout");
				disarm();
			}, config.armTimeoutMs);
			trace("arm");
		},
		disarm,
		fire(_ctx) {
			disarm();
			trace("fire");
			// Commands are resolved before a message is appended, giving the handler
			// a command-capable context for the optional session fork.
			pi.sendUserMessage(`/${INTERNAL_FIRE_COMMAND}`, { deliverAs: "followUp" });
		},
	};

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		disarm();

		for (const warning of warnings) {
			ctx.ui.notify(`double-tap-continue config: ${warning}`, "warning");
		}
		if (!config.enabled) {
			ctx.ui.notify("double-tap-continue is disabled via config", "info");
			return;
		}

		// Install the editor wrapper. pi re-creates the component, copying text
		// and wiring all native callbacks (onSubmit, action handlers, …) onto it.
		ctx.ui.setEditorComponent((tui, theme, keybindings) => new DoubleTapEditor(tui, theme, keybindings, hooks));
	});

	const sendContinue = (send: typeof pi.sendUserMessage, sendSilent: typeof pi.sendMessage) => {
		if (config.deleteMessageAfterSend) {
			void sendSilent(
				{ customType: WIDGET_KEY, content: config.continueMessage, display: false },
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} else {
			void send(config.continueMessage, { deliverAs: "followUp" });
		}
	};

	pi.registerCommand(INTERNAL_FIRE_COMMAND, {
		description: "Internal command used by double-tap-continue",
		handler: async (_args, ctx) => {
			const branch = ctx.sessionManager.getBranch();
			let lastUserIndex = -1;
			for (let index = branch.length - 1; index >= 0; index--) {
				const entry = branch[index];
				if (entry.type === "message" && entry.message.role === "user") {
					lastUserIndex = index;
					break;
				}
			}

			const entriesAfterLastUser = lastUserIndex === -1 ? [] : branch.slice(lastUserIndex + 1);
			const assistantTokens = entriesAfterLastUser.reduce((total, entry) => {
				return entry.type === "message" && entry.message.role === "assistant"
					? total + estimateTokens(entry.message)
					: total;
			}, 0);
			const onlyTinyAssistantOutput = entriesAfterLastUser.every(
				(entry) => entry.type === "message" && entry.message.role === "assistant",
			);
			const canRewind =
				config.rewindEmptyTurn &&
				lastUserIndex !== -1 &&
				onlyTinyAssistantOutput &&
				assistantTokens <= config.rewindMaxAssistantTokens;

			if (canRewind) {
				const lastUser = branch[lastUserIndex];
				trace("rewind", { assistantTokens, lastUserId: lastUser.id });
				const result = await ctx.fork(lastUser.id, {
					position: "at",
					withSession: async (newCtx) => sendContinue(newCtx.sendUserMessage, newCtx.sendMessage),
				});
				if (!result.cancelled) return;
				trace("rewind_cancelled");
			}

			trace("continue_without_rewind", { assistantTokens });
			sendContinue(pi.sendUserMessage, pi.sendMessage);
		},
	});

	pi.registerCommand("double-tap-continue", {
		description: "Show double-tap-continue status and effective config",
		handler: async (_args, ctx) => {
			const lines = [
				`enabled:                         ${config.enabled}`,
				`shortcutKey:                     ${config.shortcutKey}`,
				`armedWidgetText:                 ${JSON.stringify(config.armedWidgetText)}`,
				`armTimeoutMs:                    ${config.armTimeoutMs}`,
				`continueMessage:                 ${JSON.stringify(config.continueMessage)}`,
				`rewindEmptyTurn:                 ${config.rewindEmptyTurn}`,
				`rewindMaxAssistantTokens:        ${config.rewindMaxAssistantTokens}`,
				`deleteMessageAfterSend:           ${config.deleteMessageAfterSend}`,
				"config layers:",
				...layers.map((layer) => `  ${layer.loaded ? "loaded" : "missing"}: ${layer.path}`),
			];
			ctx.ui.notify(`double-tap-continue config:\n${lines.join("\n")}`, "info");
		},
	});
}
