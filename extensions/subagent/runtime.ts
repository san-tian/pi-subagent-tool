import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";

export interface SubagentUsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface RunPiSubagentOptions {
	cwd: string;
	prompt: string;
	model?: string;
	tools?: string[];
	signal?: AbortSignal;
	systemPrompt?: string;
	hiddenContext?: string;
	hiddenContextType?: string;
	extraExtensions?: string[];
}

export interface PiSubagentRunResult {
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: SubagentUsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

const TEMP_EXTENSION_NAME = "session-memory-subagent-ext.ts";
const TEMP_PAYLOAD_NAME = "session-memory-subagent-payload.json";

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

async function createTempExtension(
	systemPrompt: string | undefined,
	hiddenContext: string | undefined,
	hiddenContextType: string,
): Promise<{ dir: string; extensionPath: string } | null> {
	if (!systemPrompt && !hiddenContext) {
		return null;
	}

	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-session-memory-subagent-"));
	const payloadPath = path.join(dir, TEMP_PAYLOAD_NAME);
	const extensionPath = path.join(dir, TEMP_EXTENSION_NAME);

	await fs.promises.writeFile(
		payloadPath,
		JSON.stringify(
			{
				systemPrompt,
				hiddenContext,
				hiddenContextType,
			},
			null,
			2,
		),
		"utf8",
	);

	const source = `
import fs from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const payload = JSON.parse(fs.readFileSync(${JSON.stringify(payloadPath)}, "utf8"));

export default function(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		const result: { systemPrompt?: string; message?: { customType: string; content: string; display: boolean } } = {};
		if (typeof payload.systemPrompt === "string" && payload.systemPrompt.length > 0) {
			result.systemPrompt = payload.systemPrompt;
		}
		if (typeof payload.hiddenContext === "string" && payload.hiddenContext.length > 0) {
			result.message = {
				customType: payload.hiddenContextType || "subagent-hidden-context",
				content: payload.hiddenContext,
				display: false,
			};
		}
		return result;
	});
}
`.trimStart();

	await fs.promises.writeFile(extensionPath, source, "utf8");
	return { dir, extensionPath };
}

function processEventLine(line: string, result: PiSubagentRunResult): void {
	if (!line.trim()) {
		return;
	}

	let event: any;
	try {
		event = JSON.parse(line);
	} catch {
		return;
	}

	if (event.type === "message_end" && event.message) {
		const message = event.message as Message;
		result.messages.push(message);
		if (message.role === "assistant") {
			result.usage.turns += 1;
			const usage = (message as any).usage;
			if (usage) {
				result.usage.input += usage.input || 0;
				result.usage.output += usage.output || 0;
				result.usage.cacheRead += usage.cacheRead || 0;
				result.usage.cacheWrite += usage.cacheWrite || 0;
				result.usage.cost += usage.cost?.total || 0;
				result.usage.contextTokens = usage.totalTokens || 0;
			}
			if (!result.model && (message as any).model) {
				result.model = (message as any).model;
			}
			if ((message as any).stopReason) {
				result.stopReason = (message as any).stopReason;
			}
			if ((message as any).errorMessage) {
				result.errorMessage = (message as any).errorMessage;
			}
		}
	}

	if (event.type === "tool_result_end" && event.message) {
		result.messages.push(event.message as Message);
	}
}

export async function runPiSubagent(options: RunPiSubagentOptions): Promise<PiSubagentRunResult> {
	const {
		cwd,
		prompt,
		model,
		tools,
		signal,
		systemPrompt,
		hiddenContext,
		hiddenContextType = "subagent-hidden-context",
		extraExtensions = [],
	} = options;

	const tempExtension = await createTempExtension(systemPrompt, hiddenContext, hiddenContextType);
	const args = ["--mode", "json", "-p", "--no-session"];

	if (tempExtension) {
		args.push("-e", tempExtension.extensionPath);
	}
	for (const extensionPath of extraExtensions) {
		args.push("-e", extensionPath);
	}
	if (model) {
		args.push("--model", model);
	}
	if (tools && tools.length > 0) {
		args.push("--tools", tools.join(","));
	}

	const result: PiSubagentRunResult = {
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			contextTokens: 0,
			turns: 0,
		},
	};

	try {
		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd,
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
			});

			let buffer = "";
			let wasAborted = false;

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) {
					processEventLine(line, result);
				}
			});

			proc.stderr.on("data", (data) => {
				result.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) {
					processEventLine(buffer, result);
				}
				result.exitCode = code ?? 0;
				if (wasAborted && !result.errorMessage) {
					result.errorMessage = "Subagent was aborted";
				}
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				result.exitCode = 1;
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) {
							proc.kill("SIGKILL");
						}
					}, 5000);
				};
				if (signal.aborted) {
					killProc();
				} else {
					signal.addEventListener("abort", killProc, { once: true });
				}
			}

			proc.stdin.write(prompt);
			if (!prompt.endsWith("\n")) {
				proc.stdin.write("\n");
			}
			proc.stdin.end();
		});

		result.exitCode = exitCode;
		return result;
	} finally {
		if (tempExtension) {
			await fs.promises.rm(tempExtension.dir, { recursive: true, force: true });
		}
	}
}
