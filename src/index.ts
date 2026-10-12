import { Plugin } from "@opencode/plugin"
import crypto from "node:crypto"
import { config } from "./model-config.ts"
import { readAllClaudeAccounts, type ClaudeAccount } from "./keychain.ts"
import { initLogger, log } from "./logger.ts"
import {
  addExcludedBeta,
  getExcludedBetas,
  getModelBetas,
  getNextBetaToExclude,
  isLongContextError,
  LONG_CONTEXT_BETAS,
} from "./betas.ts"
import {
  SYSTEM_IDENTITY,
  transformBody,
  transformResponseStream,
} from "./transforms.ts"
import {
  forceRefreshActiveAccount,
  getActiveAccount,
  getActiveRefreshFailureKind,
  getCachedCredentials,
  getCredentialsWithBackoff,
  initAccounts,
  loadPersistedAccountSource,
  refreshAccountsList,
  refreshIfNeeded,
  reloadCredentialsFromSource,
  saveAccountSource,
  setActiveAccountSource,
  syncAuthJson,
  type ClaudeCredentials,
} from "./credentials.ts"

export {
  addExcludedBeta,
  getExcludedBetas,
  getModelBetas,
  getNextBetaToExclude,
  isLongContextError,
  LONG_CONTEXT_BETAS,
} from "./betas.ts"
export { resetExcludedBetas } from "./betas.ts"
export { fetchWithRetry, type FetchFn } from "./http.ts"
export {
  stripToolPrefix,
  SYSTEM_IDENTITY,
  transformBody,
  transformResponseStream,
} from "./transforms.ts"
export {
  getCachedCredentials,
  syncAuthJson,
  refreshAccountsList,
  type ClaudeCredentials,
} from "./credentials.ts"
export {
  buildBillingHeaderValue,
  computeCch,
  computeVersionSuffix,
  extractFirstUserMessageText,
} from "./signing.ts"

/** Integration that OpenCode routes Claude models through. */
const INTEGRATION_ID = "anthropic"

/** Stable ID for the OAuth method this plugin contributes. */
const METHOD_ID = "claude-code"

function getCliVersion(): string {
  return process.env.ANTHROPIC_CLI_VERSION ?? config.ccVersion
}

function getUserAgent(): string {
  return (
    process.env.ANTHROPIC_USER_AGENT ??
    `claude-cli/${getCliVersion()} (external, sdk-cli)`
  )
}

function getStainlessHeaders(): Record<string, string> {
  return {
    "x-stainless-arch": process.arch === "arm64" ? "arm64" : process.arch,
    "x-stainless-lang": "js",
    "x-stainless-os":
      process.platform === "darwin" ? "MacOS" : process.platform,
    "x-stainless-package-version": "0.81.0",
    "x-stainless-retry-count": "0",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": process.version,
    "x-stainless-timeout": "600",
  }
}

/**
 * Claude Code sends `?beta=true` on /v1/messages. Add it when absent and
 * leave every other URL untouched.
 */
export function buildRequestUrl(input: RequestInfo | URL): string | URL {
  const raw =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url

  const url = new URL(raw)
  if (url.pathname === "/v1/messages" && !url.searchParams.has("beta")) {
    url.searchParams.set("beta", "true")
  }

  return typeof input === "string" ? url.toString() : url
}

// Stable per-process session ID, matching Claude Code's X-Claude-Code-Session-Id
const sessionId = crypto.randomUUID()

// Maximum delay before we give up retrying and surface the error.
// A retry-after longer than this signals a quota/usage-limit reset (hours away)
// rather than a transient rate limit — retrying would hang indefinitely.
// Override with OPENCODE_CLAUDE_AUTH_MAX_RETRY_MS for longer retry windows.
const DEFAULT_MAX_RETRY_DELAY_MS = 30_000

function getMaxRetryDelayMs(): number {
  const env = process.env.OPENCODE_CLAUDE_AUTH_MAX_RETRY_MS
  if (env) {
    const parsed = parseInt(env, 10)
    if (!Number.isNaN(parsed) && parsed > 0) return parsed
  }
  return DEFAULT_MAX_RETRY_DELAY_MS
}

export function buildRequestHeaders(
  input: RequestInfo | URL,
  init: RequestInit,
  accessToken: string,
  modelId = "unknown",
  excludedBetas?: Set<string>,
): Headers {
  const headers = new Headers()

  if (input instanceof Request) {
    input.headers.forEach((value, key) => {
      headers.set(key, value)
    })
  }

  if (init.headers instanceof Headers) {
    init.headers.forEach((value, key) => {
      headers.set(key, value)
    })
  } else if (Array.isArray(init.headers)) {
    for (const [key, value] of init.headers) {
      if (typeof value !== "undefined") {
        headers.set(key, String(value))
      }
    }
  } else if (init.headers) {
    for (const [key, value] of Object.entries(init.headers)) {
      if (typeof value !== "undefined") {
        headers.set(key, String(value))
      }
    }
  }

  const modelBetas = getModelBetas(modelId, excludedBetas)
  const incomingBeta = headers.get("anthropic-beta") ?? ""
  const mergedBetas = [
    ...new Set([
      ...modelBetas,
      ...incomingBeta
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ]),
  ]

  headers.set("authorization", `Bearer ${accessToken}`)
  headers.set("anthropic-version", "2023-06-01")
  headers.set("anthropic-beta", mergedBetas.join(","))
  headers.set("anthropic-dangerous-direct-browser-access", "true")
  headers.set("x-app", "cli")
  headers.set("user-agent", getUserAgent())
  headers.set("x-client-request-id", crypto.randomUUID())
  headers.set("X-Claude-Code-Session-Id", sessionId)
  for (const [key, value] of Object.entries(getStainlessHeaders())) {
    if (!headers.has(key)) headers.set(key, value)
  }
  headers.delete("x-api-key")

  return headers
}

/** Model ID as it appears on the wire, or null when the body has none. */
export function parseModelId(body: string | undefined): string | null {
  if (!body) return null
  try {
    return (JSON.parse(body) as { model?: string }).model ?? null
  } catch {
    return null
  }
}

/** Minimal view of a provider failure, mirroring `SessionError.Error`. */
export interface RetryErrorInfo {
  status?: number
  type?: string
  message?: string
  body?: string
}

export type RetryOutcome =
  | { retry: true; delay: number; reason: string; excludedBeta?: string }
  | { retry: false; reason: string }

/**
 * Retry policy for a provider failure.
 *
 * OpenCode v2 gives plugins no way to re-issue a request, so the v1 inline
 * retry loops are decomposed: this decides *whether* to retry, and the
 * `http.request` hook rebuilds the next attempt from current credentials and
 * beta exclusions.
 *
 * Returns null to leave OpenCode's own proposed decision untouched.
 *
 * Deliberately synchronous and side-effect-free apart from the beta
 * bookkeeping below — the credential work a 401 or a rotated 429 needs lives
 * in `recoverRejectedToken` / `pickUpRotatedToken`, which the retry hook
 * applies to this decision. Keeping the policy separable is what makes it
 * testable without a live keychain.
 *
 * NOTE: deciding to drop a long-context beta also records that exclusion, so
 * the rebuilt request omits it. The side effect is intentional and is what
 * makes the retry actually differ from the attempt that just failed.
 */
export function decideRetry(
  error: RetryErrorInfo,
  attempt: number,
  modelId: string,
  retryAfterMs?: number,
): RetryOutcome | null {
  const status = error.status

  // Checked before the auth and rate-limit branches below, which inverts v1's
  // inline ordering. A long-context rejection is a header problem, so the
  // credential work those branches trigger is wasted on it; v1 paid for one
  // such request on a long-context 429 and reached the same answer.
  if (
    (status === 400 || status === 429) &&
    error.body &&
    isLongContextError(error.body)
  ) {
    const betaToExclude = getNextBetaToExclude(modelId)
    if (betaToExclude) {
      addExcludedBeta(modelId, betaToExclude)
      return {
        retry: true,
        delay: 0,
        reason: "long_context_beta_excluded",
        excludedBeta: betaToExclude,
      }
    }
    // Every long-context beta is already excluded — stop.
    return { retry: false, reason: "long_context_betas_exhausted" }
  }

  // Token expired or was rejected mid-session. The retry hook still has to
  // produce a *different* token for this to be worth anything; see
  // recoverRejectedToken.
  if (status === 401) {
    if (attempt > 2) return { retry: false, reason: "auth_retry_exhausted" }
    return { retry: true, delay: 0, reason: "auth_refresh" }
  }

  if (status === 429 || status === 529) {
    const delay = retryAfterMs ?? attempt * 2000
    // A delay past the cap means a quota/usage-limit reset hours away, not a
    // transient rate limit. Surface the error instead of hanging until then.
    if (delay > getMaxRetryDelayMs()) {
      return { retry: false, reason: "rate_limit_quota" }
    }
    return { retry: true, delay, reason: "rate_limited" }
  }

  return null
}

/** Parse a `retry-after` header into milliseconds. */
export function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined
  const parsed = parseInt(value, 10)
  if (Number.isNaN(parsed)) return undefined
  return parsed * 1000
}

/** Credential lookups the 401/429 recovery paths need, injectable for tests. */
export interface CredentialRecoveryDeps {
  reload: () => ClaudeCredentials | null
  forceRefresh: () => Promise<ClaudeCredentials | null>
}

const defaultRecoveryDeps: CredentialRecoveryDeps = {
  reload: reloadCredentialsFromSource,
  forceRefresh: forceRefreshActiveAccount,
}

/**
 * Produce a credential that differs from the one the API just rejected.
 *
 * Recovers from a rejected token first by adopting credentials rotated
 * externally (cswap switching accounts, the claude CLI, another OpenCode
 * instance), then by forcing an OAuth refresh when the store still holds the
 * token that was just rejected.
 *
 * Most cases resolve on the reload: a cold or unreadable store yields null
 * (reloadCredentialsFromSource rejects anything expiring within 60s), so the
 * force refresh runs immediately.
 *
 * Returns null when neither step produced a new token, which is the signal to
 * stop retrying — a retry with the rejected token would fail identically.
 *
 * `tokenInUse` is required, not optional: every decision here is "is this
 * different from what the API rejected", and without it the first credential
 * read trivially looks like progress.
 */
export async function recoverRejectedToken(
  tokenInUse: string,
  modelId: string,
  deps: CredentialRecoveryDeps = defaultRecoveryDeps,
): Promise<ClaudeCredentials | null> {
  let candidate: ClaudeCredentials | null = null

  // reloadCredentialsFromSource already catches its own source read and
  // returns null, so this is unreachable today. It stays because the
  // guarantee worth keeping is that no reload failure turns a well-formed 401
  // into an exception thrown out of the retry hook. It logs so a future
  // reload that does throw is diagnosable rather than silently null-coalesced.
  try {
    candidate = deps.reload()
  } catch (err) {
    log("auth_recovery_reload_threw", {
      modelId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  if (!candidate || candidate.accessToken === tokenInUse) {
    try {
      candidate = await deps.forceRefresh()
    } catch (err) {
      // A rejected refresh and a refresh that returned null are different
      // operator-facing diagnoses; auth_recovery_exhausted below collapses
      // them, so record this one here.
      log("auth_recovery_force_refresh_threw", {
        modelId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Re-checked, not copy-pasted: the guard above decides whether to force a
  // refresh, this one decides whether that refresh actually produced a token
  // worth retrying with.
  if (!candidate || candidate.accessToken === tokenInUse) {
    log("auth_recovery_exhausted", { modelId })
    return null
  }

  log("auth_recovery_retry", { modelId })
  return candidate
}

/**
 * Credentials replaced externally since the rate-limited attempt, or null.
 *
 * An external switch — cswap rotating off an exhausted account — leaves this
 * session on the old token until the 30s credential cache expires. Re-reading
 * once means a rate limit that has already been resolved elsewhere is not
 * surfaced; when nothing changed this costs one source read and no retry.
 *
 * `tokenInUse` is required for the same reason as in recoverRejectedToken:
 * "changed" is meaningless without the value it changed from.
 */
export function pickUpRotatedToken(
  tokenInUse: string,
  modelId: string,
  reload: () => ClaudeCredentials | null = reloadCredentialsFromSource,
): ClaudeCredentials | null {
  let rotated: ClaudeCredentials | null = null
  // Unreachable today for the same reason as recoverRejectedToken's reload
  // catch, and kept on the same grounds.
  try {
    rotated = reload()
  } catch (err) {
    log("rate_limit_reload_threw", {
      modelId,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }

  if (!rotated || rotated.accessToken === tokenInUse) return null

  // Named for what was observed, not for what it implies. A changed token is
  // not proof of an account switch: a routine refresh of this same exhausted
  // account by another instance or the claude CLI changes the token too, and
  // that retry hits the same quota. Accepted cost — one request — but the log
  // must not tell a quota investigation "we switched accounts" when all it
  // saw was a different token.
  log("rate_limit_token_changed", { modelId })
  return rotated
}

/** Build the account picker shown when more than one Claude account exists. */
export function buildAccountOptions(
  accounts: ClaudeAccount[],
  activeSource: string | null,
): Array<{ value: string; label: string; description?: string }> {
  return accounts.map((account) => ({
    value: account.source,
    label: account.label,
    description:
      account.source === activeSource
        ? `${account.source} (active)`
        : account.source,
  }))
}

/** Resolve the account a form answer refers to, falling back to the first. */
export function resolveAccount(
  accounts: ClaudeAccount[],
  selectedSource: unknown,
): ClaudeAccount | undefined {
  if (typeof selectedSource === "string") {
    const found = accounts.find((a) => a.source === selectedSource)
    if (found) return found
  }
  return accounts[0]
}

function describeSource(account: ClaudeAccount): string {
  return account.source === "file"
    ? `credentials file (${account.configDir ?? "~/.claude"}/.credentials.json)`
    : `macOS Keychain (${account.source})`
}

function toOAuthCredential(creds: ClaudeCredentials) {
  return {
    type: "oauth" as const,
    // Branded in the schema; the value is the method ID string.
    methodID: METHOD_ID as never,
    access: creds.accessToken,
    refresh: creds.refreshToken,
    expires: creds.expiresAt,
  }
}

const SYNC_INTERVAL = 5 * 60 * 1000 // 5 minutes
const PROACTIVE_REFRESH_THRESHOLD_MS = 60 * 60 * 1000 // 1 hour before expiry

/**
 * Keep auth.json synced and refresh the active token ahead of expiry.
 *
 * Retained from v1 rather than left to the method's `refresh()` callback:
 * that callback only runs when OpenCode asks, so a token that expires while
 * the user is idle still produces a mid-session "run `claude` to
 * re-authenticate". refreshIfNeeded() always resolves the currently ACTIVE
 * account internally — not a closure-captured list — so this stays correct
 * across account switches.
 */
function startProactiveRefresh(): () => void {
  let warned = false
  const timer = setInterval(async () => {
    try {
      const account = getActiveAccount()
      log("proactive_refresh_check", {
        source: account?.source ?? null,
        expiresAt: account?.credentials?.expiresAt ?? null,
        thresholdMs: PROACTIVE_REFRESH_THRESHOLD_MS,
      })

      const creds = await refreshIfNeeded(
        undefined,
        PROACTIVE_REFRESH_THRESHOLD_MS,
      )
      if (creds) {
        syncAuthJson(creds)
        if (warned) {
          log("proactive_refresh_recovered", { source: account?.source })
        }
        warned = false
      } else {
        log("proactive_refresh_failed", { source: account?.source })
        // Only warn once per outage — otherwise this fires every
        // SYNC_INTERVAL (5 min) for as long as refresh keeps failing.
        if (!warned) {
          warned = true
          console.warn(
            "opencode-claude-auth: Proactive token refresh failed. Run `claude` to re-authenticate.",
          )
        }
      }
    } catch {
      // Non-fatal
    }
  }, SYNC_INTERVAL)
  timer.unref()

  return () => {
    clearInterval(timer)
  }
}

export default Plugin.define({
  id: "opencode-claude-auth",

  async setup(ctx) {
    initLogger()

    let accounts: ClaudeAccount[] = []
    try {
      accounts = readAllClaudeAccounts()
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      log("plugin_init_error", { error })
      console.warn(
        "opencode-claude-auth: Failed to read Claude Code credentials:",
        error,
      )
      return
    }

    initAccounts(accounts)

    // Resolved once so the account picker and the `label()` callback agree
    // with whichever account was actually activated. A persisted source that
    // no longer exists must not leak into either.
    const defaultAccount = accounts.length
      ? resolveAccount(accounts, loadPersistedAccountSource())
      : undefined

    let stopProactiveRefresh: (() => void) | undefined

    if (defaultAccount) {
      setActiveAccountSource(defaultAccount.source)

      log("plugin_init", {
        accountCount: accounts.length,
        sources: accounts.map((a) => a.source),
        activeSource: defaultAccount.source,
      })

      const initialCreds = await getCachedCredentials()
      if (initialCreds) {
        syncAuthJson(initialCreds)
      } else {
        console.warn(
          "opencode-claude-auth: Claude credentials are expired and could not be refreshed. Run `claude` to re-authenticate.",
        )
      }

      stopProactiveRefresh = startProactiveRefresh()
    } else {
      log("plugin_init_no_accounts", { reason: "no credentials found" })
      console.warn(
        "opencode-claude-auth: No Claude Code credentials found. Running in API key mode with transform hooks enabled.",
      )
    }

    // --- Auth: contribute an OAuth method to the anthropic integration ---
    // v1's `auth.methods[].prompts` was a lazy getter. v2 transforms must be
    // synchronous and replayable, so the account list is captured here and
    // refreshed via ctx.integration.reload() when it changes.
    if (defaultAccount) {
      const options = buildAccountOptions(accounts, defaultAccount.source)

      await ctx.integration.transform((editor) => {
        editor.method.update({
          integrationID: INTEGRATION_ID,
          method: {
            id: METHOD_ID,
            type: "oauth",
            label: "Use Claude Code credentials",
            // A single account needs no picker, matching v1 behaviour.
            ...(options.length > 1
              ? {
                  form: [
                    {
                      key: "account",
                      type: "string" as const,
                      title: "Claude Code account",
                      description: "Select which Claude Code account to use.",
                      options,
                    },
                  ] as const,
                }
              : {}),
          },

          async authorize(answer) {
            const latest = refreshAccountsList()
            const chosen =
              resolveAccount(latest, answer?.account) ?? defaultAccount

            setActiveAccountSource(chosen.source)
            const creds = (await getCachedCredentials()) ?? chosen.credentials

            syncAuthJson(creds)
            saveAccountSource(chosen.source)

            log("auth_authorize", { source: chosen.source })

            return {
              url: "",
              instructions: `Using ${chosen.label} — credentials loaded from ${describeSource(chosen)}.`,
              mode: "auto",
              callback: Promise.resolve(toOAuthCredential(creds)),
            }
          },

          // Replaces v1's auth.json sync timer as the *pull* path: OpenCode
          // asks for a fresh credential. The interval above still runs, to
          // cover expiry while OpenCode is not asking.
          async refresh() {
            const creds = await getCachedCredentials()
            if (!creds) {
              log("auth_refresh_failed", { reason: "no credentials" })
              throw new Error(
                "Claude Code credentials are unavailable or expired. Run `claude` to refresh them.",
              )
            }
            log("auth_refresh", { expiresAt: creds.expiresAt })
            return toOAuthCredential(creds)
          },

          label() {
            const source = loadPersistedAccountSource()
            const account = resolveAccount(accounts, source)
            return (account ?? defaultAccount).label
          },
        })
      })
    }

    // --- Claude Code subscription usage is not billed per token ---
    await ctx.model.transform((editor) => {
      const record = editor.provider.get(INTEGRATION_ID)
      if (!record) return
      for (const modelID of record.models.keys()) {
        editor.update(INTEGRATION_ID, modelID, (model) => {
          for (const tier of model.cost) {
            // Branded Money values; zero is valid for every tier.
            tier.input = 0 as never
            tier.output = 0 as never
            tier.cache.read = 0 as never
            tier.cache.write = 0 as never
          }
        })
      }
      log("models_cost_zeroed", { modelCount: record.models.size })
    })

    // --- System identity prefix, required for OAuth validation ---
    // Registered for every request kind: title and compaction calls hit the
    // same API and are validated the same way.
    const injectIdentity = (event: {
      system: Array<{ type: string; text?: string }>
    }) => {
      const present = event.system.some(
        (part) =>
          part.type === "text" &&
          typeof part.text === "string" &&
          part.text.includes(SYSTEM_IDENTITY),
      )
      if (!present) {
        event.system.unshift({ type: "text", text: SYSTEM_IDENTITY })
      }
    }

    for (const kind of [
      "context",
      "compaction",
      "generate",
      "title",
    ] as const) {
      await ctx.session.hook(kind, injectIdentity, {
        providerID: INTEGRATION_ID,
      })
    }

    // `retry-after` is only visible on the response; the retry hook sees a
    // classified error. Bridge the two per session.
    const retryAfterBySession = new Map<string, number>()

    // The token each session last sent. The 401 and rotated-429 recovery
    // paths compare against it to tell "a different credential is available"
    // from "retrying would re-send the token that just failed".
    const tokenBySession = new Map<string, string>()

    // --- Outbound request: auth, Claude Code headers, body transform ---
    await ctx.session.hook(
      "http.request",
      async (event) => {
        let creds = await getCachedCredentials()
        if (!creds) {
          // A transient refresh rate-limit must not surface as a hard error.
          // Wait (bounded, abort-aware) for our cooldown to clear or for a
          // sibling OpenCode instance / the claude CLI to write a fresh token
          // to the shared store.
          creds = await getCredentialsWithBackoff({
            signal: event.request.signal ?? undefined,
          })
        }
        if (!creds) {
          const modelId = String(event.model.id)
          // v1 synthesised a 429 response here so the AI SDK would back off.
          // A v2 http.request hook can only mutate the outgoing request, so
          // the transient case has to surface as a throw; the distinct
          // message and log event keep it diagnosable as retryable rather
          // than as a dead refresh token.
          if (getActiveRefreshFailureKind() === "transient") {
            log("fetch_credentials_transient_exhausted", { modelId })
            throw new Error(
              "Claude token refresh is rate-limited; retry shortly.",
            )
          }
          log("fetch_no_credentials", { modelId })
          throw new Error(
            "Claude Code credentials are unavailable or expired. Run `claude` to refresh them.",
          )
        }

        const request = event.request
        const hasBody = request.method !== "GET" && request.method !== "HEAD"
        const originalBody = hasBody ? await request.text() : undefined

        const modelId = parseModelId(originalBody) ?? String(event.model.id)
        const excluded = getExcludedBetas(modelId)

        const url = buildRequestUrl(request.url) as string
        const headers = buildRequestHeaders(
          url,
          { headers: request.headers },
          creds.accessToken,
          modelId,
          excluded,
        )
        const body = hasBody
          ? (transformBody(originalBody) as string | undefined)
          : undefined

        event.request = new Request(url, {
          method: request.method,
          headers,
          body,
          signal: request.signal,
        })

        tokenBySession.set(event.sessionID, creds.accessToken)

        const betas = (headers.get("anthropic-beta") ?? "")
          .split(",")
          .filter(Boolean)
        log("fetch_headers_built", { modelId, betas, kind: event.kind })
      },
      { providerID: INTEGRATION_ID },
    )

    // --- Inbound response: capture retry-after, strip tool prefixes ---
    await ctx.session.hook(
      "http.response",
      (event) => {
        const modelId = String(event.model.id)
        const retryAfterMs = parseRetryAfterMs(
          event.response.headers.get("retry-after"),
        )
        if (retryAfterMs !== undefined) {
          retryAfterBySession.set(event.sessionID, retryAfterMs)
        } else {
          retryAfterBySession.delete(event.sessionID)
        }

        // Record non-200 responses without writing over OpenCode's terminal UI.
        if (!event.response.ok) {
          const status = event.response.status
          event.response
            .clone()
            .text()
            .then((errorBody) => {
              let message = errorBody
              try {
                const parsed = JSON.parse(errorBody) as {
                  error?: { type?: string; message?: string }
                }
                message =
                  parsed.error?.message ?? parsed.error?.type ?? errorBody
              } catch {}
              log("fetch_error_response", {
                status,
                modelId,
                kind: event.kind,
                message,
              })
            })
            .catch(() => {})
        }

        // A 401 carries an error body, not an SSE stream.
        if (event.response.status === 401) return

        event.response = transformResponseStream(event.response)
      },
      { providerID: INTEGRATION_ID },
    )

    // --- Retry policy: 429/529 backoff, 401 recovery, beta exclusion ---
    await ctx.session.hook(
      "retry",
      async (event) => {
        const modelId = String(event.model.id)
        const tokenInUse = tokenBySession.get(event.sessionID)

        let outcome = decideRetry(
          {
            status: event.error.status,
            type: event.error.type,
            message: event.error.message,
            body: event.error.response?.body,
          },
          event.attempt,
          modelId,
          retryAfterBySession.get(event.sessionID),
        )

        if (!outcome) return

        // Both recovery steps below are comparisons against the token this
        // session actually sent. Without one — the failure happened before
        // http.request recorded anything — there is nothing to compare, so
        // the policy decision stands and the next attempt simply rebuilds
        // from whatever credentials are current.
        if (tokenInUse) {
          // Retrying a 401 only differs from the failed attempt if a
          // different token is available, so the policy's "yes" is
          // conditional on recovery actually producing one.
          if (outcome.retry && outcome.reason === "auth_refresh") {
            const recovered = await recoverRejectedToken(tokenInUse, modelId)
            if (recovered) {
              tokenBySession.set(event.sessionID, recovered.accessToken)
            } else {
              outcome = { retry: false, reason: "auth_recovery_exhausted" }
            }
          }

          // A rate limit already resolved elsewhere needs no backoff.
          if (outcome.retry && outcome.reason === "rate_limited") {
            const rotated = pickUpRotatedToken(tokenInUse, modelId)
            if (rotated) {
              tokenBySession.set(event.sessionID, rotated.accessToken)
              outcome = {
                retry: true,
                delay: 0,
                reason: "rate_limit_token_changed",
              }
            }
          }
        }

        retryAfterBySession.delete(event.sessionID)

        event.decision = outcome.retry
          ? { retry: true, delay: outcome.delay }
          : { retry: false }

        log("retry_decision", {
          modelId,
          attempt: event.attempt,
          status: event.error.status ?? 0,
          retry: outcome.retry,
          reason: outcome.reason,
          delayMs: outcome.retry ? outcome.delay : 0,
          longContextBetaCount: LONG_CONTEXT_BETAS.length,
        })
      },
      { providerID: INTEGRATION_ID },
    )

    return () => {
      stopProactiveRefresh?.()
      retryAfterBySession.clear()
      tokenBySession.clear()
    }
  },
})
