// dsh-codex-login — official ChatGPT (Codex) OAuth sign-in for DSH's
// `openai-codex` model provider, exposed as agent tools.
//
// Why this plugin exists: DSH ships the pi-ai `openai-codex` provider (a
// catalog provider that authenticates only through ChatGPT OAuth), and the
// host mounts the `dsh-authorization` seam that pi-ai registers its
// "Sign in with ChatGPT" flow on — but the bundled web client exposes no
// authorization RPC, so no UI can start that flow. This plugin drives the
// same official seam from the host plane and surfaces it as a tool:
//
//   codex_login            start / status / submit_code / cancel
//
// The flow itself (PKCE, browser redirect to http://localhost:1455/auth/callback,
// token exchange, credential commit, refresh locking) is 100% pi-ai's own
// implementation; this plugin only starts it and relays notices/prompts.
//
// Storage discipline: no logs of tokens, no files written; the credential is
// committed by the authorization flow into the harness credential store as
// `llm-pi-ai/openai-codex`.
import { defineTool } from "@deepseek-ai/dsh-tools";

const name = "codex-login";
const inject = ["tools", "authorization", "credentials"];

/** Credential record the pi-ai openai-codex flow commits into. */
const CREDENTIAL_KEY = "llm-pi-ai/openai-codex";
/** How long a start/status/submit_code call waits for the flow to move. */
const SETTLE_MS = 4000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Drop `undefined` members so tool outputs stay lossless JSON. */
function clean(value) {
	if (Array.isArray(value)) return value.map(clean);
	if (value !== null && typeof value === "object") {
		const out = {};
		for (const [key, item] of Object.entries(value)) {
			if (item === undefined) continue;
			out[key] = clean(item);
		}
		return out;
	}
	return value;
}

function apply(ctx) {
	/** The one running attempt, if any. The seam allows one per credential key. */
	let attempt = null;

	async function credentialConfigured() {
		const credentials = ctx.get("credentials");
		if (credentials === undefined) return false;
		try {
			const record = await credentials.describeRecord(CREDENTIAL_KEY);
			return record?.configured === true;
		} catch {
			return false;
		}
	}

	function flowEntry() {
		try {
			const authorization = ctx.get("authorization");
			if (authorization === undefined) return undefined;
			return authorization.describe(CREDENTIAL_KEY);
		} catch {
			return undefined;
		}
	}

	function snapshot() {
		if (attempt === null) return { inFlight: false };
		const done = attempt.done === true;
		return clean({
			inFlight: !done,
			url: attempt.url,
			deviceCode: attempt.code,
			notice: attempt.message,
			needsCode: attempt.promptMessage !== undefined,
			prompt: attempt.promptMessage,
			done,
			authorized: attempt.result?.status === "authorized",
			error: attempt.error
		});
	}

	async function start() {
		if (await credentialConfigured()) {
			return {
				status: "already_authorized",
				message: "openai-codex 已授权（凭据已存在），无需重复登录。"
			};
		}
		if (attempt !== null && attempt.done !== true) {
			return { status: "in_flight", ...snapshot() };
		}
		const authorization = ctx.get("authorization");
		if (authorization === undefined) {
			return { status: "unavailable", message: "宿主未挂载 authorization 服务。" };
		}
		const flow = flowEntry();
		if (flow === undefined) {
			return { status: "unavailable", message: "未注册 openai-codex 授权流：llm-pi-ai 与 dsh-authorization 必须同时挂载。" };
		}
		const methods = Array.isArray(flow.methods) ? flow.methods : [];
		const method = methods.length > 0 ? methods[0].id : "oauth";
		const state = {
			controller: new AbortController(),
			url: undefined,
			code: undefined,
			message: undefined,
			promptMessage: undefined,
			resolvePrompt: undefined,
			rejectPrompt: undefined,
			done: false,
			result: undefined,
			error: undefined
		};
		attempt = state;
		const interaction = {
			notify(notice) {
				if (typeof notice?.url === "string") state.url = notice.url;
				if (typeof notice?.code === "string") state.code = notice.code;
				if (typeof notice?.message === "string") state.message = notice.message;
			},
			prompt(prompt) {
				state.promptMessage = typeof prompt?.message === "string" && prompt.message.length > 0
					? prompt.message
					: "请粘贴浏览器最终显示的授权码（或完整回调 URL）。";
				return new Promise((resolve, reject) => {
					state.resolvePrompt = resolve;
					state.rejectPrompt = reject;
				});
			}
		};
		authorization.begin({
			key: CREDENTIAL_KEY,
			method,
			signal: state.controller.signal,
			interaction
		}).then((result) => {
			state.done = true;
			state.result = result;
		}).catch((error) => {
			state.done = true;
			state.error = error instanceof Error ? error.message : String(error);
		});
		const deadline = Date.now() + SETTLE_MS;
		while (!state.done && state.url === undefined && state.code === undefined && state.promptMessage === undefined && Date.now() < deadline) {
			await sleep(150);
		}
		if (state.done) {
			if (state.result?.status === "authorized") return { status: "authorized", ...snapshot() };
			return { status: "failed", ...snapshot() };
		}
		return {
			status: "started",
			...snapshot(),
			message: state.promptMessage !== undefined
				? "浏览器自动回调未完成，需要把授权码交给本工具（action=submit_code）。"
				: (state.url !== undefined
					? "请在浏览器打开 url 完成 ChatGPT 登录；完成后调用 action=status 确认。"
					: "授权流程已启动，尚未收到链接；稍后调用 action=status。")
		};
	}

	async function status() {
		return { status: "state", configured: await credentialConfigured(), ...snapshot() };
	}

	async function submitCode(code) {
		if (attempt === null || attempt.resolvePrompt === undefined) {
			return { status: "no_pending_prompt", configured: await credentialConfigured(), ...snapshot() };
		}
		attempt.resolvePrompt(code);
		attempt.resolvePrompt = undefined;
		attempt.rejectPrompt = undefined;
		attempt.promptMessage = undefined;
		const deadline = Date.now() + SETTLE_MS;
		while (!attempt.done && Date.now() < deadline) await sleep(150);
		return {
			status: attempt.done ? (attempt.result?.status === "authorized" ? "authorized" : "failed") : "waiting",
			configured: await credentialConfigured(),
			...snapshot()
		};
	}

	function cancel() {
		if (attempt !== null && attempt.done !== true) {
			try {
				attempt.controller.abort(new Error("cancelled by codex_login"));
			} catch { /* ignore */ }
			return { status: "cancelled" };
		}
		return { status: "idle" };
	}

	ctx.tools.register(defineTool({
		name: "codex_login",
		description: "登录 ChatGPT (Codex) 官方 OAuth，为 DSH 的 openai-codex 模型提供方写入凭据；登录后 GPT-6/GPT-5.x 等 openai-codex 模型即可作为主模型使用。action: start（默认，启动登录并返回浏览器授权链接）| status（查询进度；需要时返回待粘贴的授权码提示）| submit_code（把浏览器显示的授权码交给流程，仅自动回调失败时需要，需同时给 code）| cancel（取消本次登录）。一次只允许一个进行中的登录。",
		parameters: {
			action: { type: "string", description: "start（默认）| status | submit_code | cancel" },
			code: { type: "string", description: "action=submit_code 时必填：浏览器最终显示的授权码或完整回调 URL。" }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => {
				const lines = [];
				if (typeof value?.url === "string" && value.url.length > 0) lines.push(`授权链接：${value.url}`);
				if (typeof value?.deviceCode === "string" && value.deviceCode.length > 0) lines.push(`设备码：${value.deviceCode}`);
				if (typeof value?.prompt === "string" && value.prompt.length > 0) lines.push(`需要授权码：${value.prompt}`);
				if (typeof value?.message === "string" && value.message.length > 0) lines.push(value.message);
				if (typeof value?.status === "string") lines.push(`状态：${value.status}`);
				if (typeof value?.configured === "boolean") lines.push(`凭据已配置：${value.configured ? "是" : "否"}`);
				if (typeof value?.error === "string" && value.error.length > 0) lines.push(`错误：${value.error}`);
				const text = lines.length > 0 ? lines.join("\n") : JSON.stringify(value);
				return [{ type: "text", text }];
			}
		},
		isConcurrencySafe: () => false,
		timeoutMs: 30_000,
		async execute(args) {
			const action = typeof args?.action === "string" && args.action.length > 0 ? args.action : "start";
			if (action === "status") return await status();
			if (action === "cancel") return cancel();
			if (action === "submit_code") {
				if (typeof args?.code !== "string" || args.code.trim().length === 0) {
					return { status: "needs_code", message: "action=submit_code 需要 code 参数（浏览器最终显示的授权码或完整回调 URL）。" };
				}
				return await submitCode(args.code.trim());
			}
			return await start();
		}
	}));
}

export { apply, inject, name };
