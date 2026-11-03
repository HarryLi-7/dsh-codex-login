# dsh-codex-login

DSH (DeepSeek Harness) plugin: sign in to **ChatGPT (Codex)** through the
official OAuth flow, so the pi-ai `openai-codex` provider's GPT models can be
used as the harness's **main model** — not just as a subagent.

## Why this plugin exists

DSH ships two halves of the Codex sign-in story but no bridge between them:

- `dsh-llm-pi-ai` serves the pi-ai `openai-codex` catalog provider. That
  provider is **OAuth-only**: it authenticates through ChatGPT, and it has no
  API-key method.
- The host mounts `dsh-authorization`, and pi-ai registers its
  "Sign in with ChatGPT" flow on that seam when `llm-pi-ai` mounts.
- The bundled web client exposes **no authorization RPC** (only
  `credentials/describe|set|unset`), so no bundled UI can start that flow.

This plugin drives the same official seam from the host plane and surfaces it
as an agent tool. The flow itself — PKCE, the browser redirect to
`http://localhost:1455/auth/callback`, the token exchange, the credential
commit and the cross-process refresh lock — is entirely pi-ai's own
implementation. The plugin only starts it and relays notices/prompts.

## Tool

| Tool | Actions |
|---|---|
| `codex_login` | `start` (default) — start the flow and return the browser URL; `status` — progress + credential state; `submit_code` — paste the final callback URL/code, or answer pi-ai's login-method prompt with `browser` / `device_code`; `cancel` — withdraw the attempt |

`start` begins the attempt in the background and returns as soon as the
authorization URL (or the login-method prompt) is available. Complete the
login in the browser; the credential is committed automatically.

## Where the credential goes

The flow commits one record into the harness credential store:

- key: `llm-pi-ai/openai-codex`
- kind: `grant`, payload `{ type, access, refresh, expires, accountId }`

The plugin never prints, logs, or re-emits any credential material. Tokens are
refreshed by pi-ai under its own cross-process lock.

## Model catalog

Keep the provider entry empty:

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      openai-codex: {}
```

An empty provider inherits the app's built-in pi-ai catalog — every model the
installed build supports, with **new models appearing automatically after app
updates**. Writing a `models:` list *replaces* that catalog (models are then
limited to the list and never auto-update); use `modelOverrides` to tweak a
single catalog model instead.

## Install (desktop app profile)

1. Put this package at `~/.dsh/profiles/packages/dsh-codex-login/`
2. In `~/.dsh/profiles/desktop/package.json` add
   `"dsh-codex-login": "link:/Users/<you>/.dsh/profiles/packages/dsh-codex-login"`
   and append `"dsh-codex-login"` to `dsh.profile.bundles`
3. Install dependencies with the app's bundled pnpm, then **restart the app**
4. Ask the agent to sign in; or drive the tool directly

Profiles are managed by the Electron app: the CLI refuses `--profile desktop`.

## Requirements

- DSH 0.2.1-rc.5 (any profile that mounts `dsh-authorization`, `dsh-credentials`
  and `dsh-llm-pi-ai`)
- A ChatGPT account with Codex access; model availability follows your plan

## Notes

- The OAuth callback binds `127.0.0.1:1455`; the browser must run on the same
  machine as the harness.
- One attempt per credential at a time (enforced by `dsh-authorization`).
- If the browser callback cannot reach the harness, copy the final
  `http://localhost:1455/auth/callback?code=…` URL back with `submit_code`.

## License

MIT
