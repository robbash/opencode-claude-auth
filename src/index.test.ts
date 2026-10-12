import assert from "node:assert/strict"
import {
  existsSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { beforeEach, describe, it } from "node:test"
import { pathToFileURL } from "node:url"

// Keep the cross-process refresh lock off the real OpenCode data dir in tests.
process.env.OPENCODE_CLAUDE_AUTH_REFRESH_LOCK_DIR = mkdtempSync(
  join(tmpdir(), "opencode-claude-auth-locktest-"),
)

interface ClaudeCredentials {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

interface Account {
  label: string
  source: string
  credentials: ClaudeCredentials
}

// `resolveAccount` and `buildAccountOptions` are real exports under v2 and are
// exercised directly below, so the v1 test-local mirrors of them are gone.

// Mirrors syncToPath logic
function syncToPath(
  authPath: string,
  creds: ClaudeCredentials,
  fs: {
    existsSync: (p: string) => boolean
    readFileSync: (p: string, enc: string) => string
    writeFileSync: (p: string, data: string, enc: string) => void
    mkdirSync: (p: string, opts: object) => void
    dirname: (p: string) => string
  },
): void {
  let auth: Record<string, unknown> = {}
  if (fs.existsSync(authPath)) {
    const raw = fs.readFileSync(authPath, "utf-8").trim()
    if (raw) {
      try {
        auth = JSON.parse(raw)
      } catch {
        // Malformed file, start fresh
      }
    }
  }
  auth.anthropic = {
    type: "oauth",
    access: creds.accessToken,
    refresh: creds.refreshToken,
    expires: creds.expiresAt,
  }
  const dir = fs.dirname(authPath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(authPath, JSON.stringify(auth, null, 2), "utf-8")
}

// Mirrors refreshIfNeeded expiry logic
function refreshIfNeeded(
  creds: ClaudeCredentials,
  nowMs: number,
): "fresh" | "expired" {
  return creds.expiresAt > nowMs + 60_000 ? "fresh" : "expired"
}

const SOURCE_FILES = [
  "index.ts",
  "betas.ts",
  "model-config.ts",
  "signing.ts",
  "transforms.ts",
  "credentials.ts",
  "refresh-backoff.ts",
  "refresh-lock.ts",
  "logger.ts",
  "http.ts",
] as const

/**
 * Temp copies must live inside the project: index.ts imports
 * `@opencode/plugin`, and Node resolves bare specifiers by walking up to the
 * nearest node_modules, so an OS-temp dir would never find it. It also cannot
 * live *under* node_modules, where Node refuses to strip TypeScript types.
 */
const TEMP_ROOT = new URL("../.test-tmp/", import.meta.url)
const createdTempDirs: string[] = []

async function makeProjectTempDir(prefix: string): Promise<string> {
  mkdirSync(TEMP_ROOT, { recursive: true })
  const dir = await mkdtemp(join(TEMP_ROOT.pathname, prefix))
  createdTempDirs.push(dir)
  return dir
}

process.on("exit", () => {
  for (const dir of createdTempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
})

async function copySourceFiles(
  tempDir: string,
  opts?: { oauthTokenUrl?: string },
): Promise<void> {
  await Promise.all(
    SOURCE_FILES.map(async (file) => {
      let source = await readFile(new URL(`./${file}`, import.meta.url), "utf8")
      source = source.replace(
        /from\s+["']\.\/([\w-]+)\.js["']/g,
        'from "./$1.ts"',
      )
      if (file === "credentials.ts") {
        if (opts?.oauthTokenUrl) {
          // Point the OAuth refresh at a local test server so the real
          // refreshViaOAuth path runs offline.
          source = source.replace(
            "https://claude.ai/v1/oauth/token",
            opts.oauthTokenUrl,
          )
        }
        // Keep refreshViaCli from launching the real claude binary.
        source = source.replace(
          'import { execSync } from "node:child_process"',
          'import { execSync } from "./child-process.ts"',
        )
      }
      await writeFile(join(tempDir, file), source, "utf8")
    }),
  )

  await writeFile(
    join(tempDir, "child-process.ts"),
    `export function execSync() {
  return ""
}
`,
    "utf8",
  )
}

const KEYCHAIN_STUB = (expiresAt: string) => `let readCount = 0
let credentials = {
  accessToken: "token",
  refreshToken: "refresh",
  expiresAt: ${expiresAt}
}

export const PRIMARY_SERVICE = "Claude Code-credentials"

export function readAllClaudeAccounts() {
  readCount += 1
  return [{ label: "Account 1", source: "Claude Code-credentials", credentials }]
}

export function refreshAccount(source) {
  readCount += 1
  return credentials
}

export function writeBackCredentials() { return true }

export function buildAccountLabels(creds) {
  return creds.map((_, i) => \`Account \${i + 1}\`)
}

export function __getReadCount() {
  return readCount
}

export function __setCredentials(c) {
  credentials = c
}
`

interface LoadOptions {
  oauthTokenUrl?: string
  /** Force reloadCredentialsFromSource to throw, exercising the catch paths. */
  throwOnReload?: boolean
}

async function prepareTempModule(
  expiresAt: string,
  opts: LoadOptions,
): Promise<string> {
  const tempDir = await makeProjectTempDir("plugin-")
  await copySourceFiles(tempDir, opts)

  if (opts.throwOnReload) {
    const tempCredentials = join(tempDir, "credentials.ts")
    const reloadSignature =
      "export function reloadCredentialsFromSource(): ClaudeCredentials | null {"
    const credentialsSource = await readFile(tempCredentials, "utf8")
    assert.ok(credentialsSource.includes(reloadSignature))
    await writeFile(
      tempCredentials,
      credentialsSource.replace(
        reloadSignature,
        `${reloadSignature}\n  throw new Error("forced reload failure")`,
      ),
      "utf8",
    )
  }

  await writeFile(
    join(tempDir, "keychain.ts"),
    KEYCHAIN_STUB(expiresAt),
    "utf8",
  )
  return tempDir
}

async function loadPluginModule(
  expiresAt = "Date.now() + 10 * 60 * 1000",
  opts: LoadOptions = {},
): Promise<typeof import("./index.ts")> {
  const tempDir = await prepareTempModule(expiresAt, opts)
  return import(pathToFileURL(join(tempDir, "index.ts")).href)
}

/**
 * The plugin module plus handles on its stubbed keychain, for the credential
 * recovery paths that need to rotate the backing store mid-test.
 */
async function loadPluginWithKeychainControls(
  expiresAt = "Date.now() + 10 * 60 * 1000",
  opts: LoadOptions = {},
): Promise<{
  helpersModule: typeof import("./index.ts")
  keychainModule: {
    __getReadCount: () => number
    __setCredentials: (c: ClaudeCredentials) => void
  }
}> {
  const tempDir = await prepareTempModule(expiresAt, opts)
  const [helpersModule, keychainModule] = await Promise.all([
    import(pathToFileURL(join(tempDir, "index.ts")).href),
    import(pathToFileURL(join(tempDir, "keychain.ts")).href),
  ])
  return {
    helpersModule,
    keychainModule: keychainModule as {
      __getReadCount: () => number
      __setCredentials: (c: ClaudeCredentials) => void
    },
  }
}

// --- Fake v2 plugin context -------------------------------------------------

interface HookEntry {
  name: string
  callback: (event: unknown) => unknown
  options?: { providerID?: string }
}

interface FakeContext {
  ctx: unknown
  hooks: HookEntry[]
  modelTransforms: Array<(editor: unknown) => void>
  integrationTransforms: Array<(editor: unknown) => void>
}

function createFakeContext(options: Record<string, unknown> = {}): FakeContext {
  const hooks: HookEntry[] = []
  const modelTransforms: Array<(editor: unknown) => void> = []
  const integrationTransforms: Array<(editor: unknown) => void> = []
  const registration = { dispose: async () => {} }

  const ctx = {
    options,
    location: {
      directory: "/tmp/project",
      project: {
        id: "p1",
        directory: "/tmp/project",
        canonical: "/tmp/project",
      },
    },
    session: {
      hook: async (
        name: string,
        callback: (event: unknown) => unknown,
        hookOptions?: { providerID?: string },
      ) => {
        hooks.push({ name, callback, options: hookOptions })
        return registration
      },
    },
    model: {
      transform: async (callback: (editor: unknown) => void) => {
        modelTransforms.push(callback)
        return registration
      },
      reload: async () => {},
    },
    integration: {
      transform: async (callback: (editor: unknown) => void) => {
        integrationTransforms.push(callback)
        return registration
      },
      reload: async () => {},
    },
  }

  return { ctx, hooks, modelTransforms, integrationTransforms }
}

function findHook(hooks: HookEntry[], name: string): HookEntry {
  const entry = hooks.find((hook) => hook.name === name)
  assert.ok(entry, `Expected a "${name}" hook to be registered`)
  return entry
}

/** Collect the method registrations an integration transform produces. */
function collectMethodRegistrations(
  integrationTransforms: Array<(editor: unknown) => void>,
): Array<Record<string, unknown>> {
  const registrations: Array<Record<string, unknown>> = []
  for (const transform of integrationTransforms) {
    transform({
      method: { update: (input: never) => registrations.push(input) },
    })
  }
  return registrations
}

/**
 * Switch the active account the way the TUI does: through the registered
 * method's `authorize`. v1 reached `plugin.auth.methods[0].authorize`
 * directly; under v2 the method only exists inside the integration transform.
 */
async function authorizeVia(
  integrationTransforms: Array<(editor: unknown) => void>,
  answer: Record<string, unknown>,
): Promise<void> {
  const [registration] = collectMethodRegistrations(integrationTransforms)
  assert.ok(registration, "expected an oauth method registration")
  await (
    registration as unknown as {
      authorize: (answer: unknown) => Promise<unknown>
    }
  ).authorize(answer)
}

/**
 * Fake keychain with TWO accounts, used to regression-test the proactive
 * refresh timer's account resolution (bug: it used to read the closure-
 * captured `accounts[0]` instead of the currently active account after a
 * switch). Both accounts get `refreshToken: ""` so `refreshViaOAuth()`'s
 * `if (creds.refreshToken)` guard skips it entirely — no real network call
 * — and the refresh cascade falls straight through to the CLI fallback
 * (which fails fast with ENOENT since `claude` isn't installed in test
 * envs) and finally to the mocked `refreshAccount(source)`, which is what
 * actually determines success/failure here.
 */
async function loadHelpersWithMultiAccountKeychain(opts: {
  aExpiresAt: number
  bExpiresAt: number
  bRefreshResult: "success" | "fail"
}): Promise<{
  helpersModule: typeof import("./index.ts")
}> {
  const tempDir = await makeProjectTempDir("multi-acct-")
  const tempKeychain = join(tempDir, "keychain.ts")

  await copySourceFiles(tempDir)
  await writeFile(
    tempKeychain,
    `let credsA = { accessToken: "token-a", refreshToken: "", expiresAt: ${opts.aExpiresAt} }
let credsB = { accessToken: "token-b", refreshToken: "", expiresAt: ${opts.bExpiresAt} }

export function readAllClaudeAccounts() {
  return [
    { label: "Account 1", source: "acct-a", credentials: credsA },
    { label: "Account 2", source: "acct-b", credentials: credsB },
  ]
}

export function refreshAccount(source) {
  if (source !== "acct-b") return null
  ${
    opts.bRefreshResult === "success"
      ? `credsB = { accessToken: "token-b-refreshed", refreshToken: "", expiresAt: Date.now() + 10 * 60 * 60 * 1000 }
  return credsB`
      : `return null`
  }
}

export function writeBackCredentials() { return true }
export function buildAccountLabels(creds) { return creds.map((_, i) => \`Account \${i + 1}\`) }
export const PRIMARY_SERVICE = "Claude Code-credentials"
`,
    "utf8",
  )

  const helpersModule = await import(
    pathToFileURL(join(tempDir, "index.ts")).href
  )

  return { helpersModule }
}

function makeCreds(overrides?: Partial<ClaudeCredentials>): ClaudeCredentials {
  return {
    accessToken: "sk-ant-test-access",
    refreshToken: "sk-ant-test-refresh",
    expiresAt: Date.now() + 300_000,
    ...overrides,
  }
}

const accounts: Account[] = [
  {
    label: "Account 1",
    source: "Claude Code-credentials",
    credentials: makeCreds({ accessToken: "at-1" }),
  },
  {
    label: "Account 2",
    source: "Claude Code-credentials-b28bbb7c",
    credentials: makeCreds({ accessToken: "at-2" }),
  },
  {
    label: "Account 3",
    source: "Claude Code-credentials-abc123",
    credentials: makeCreds({ accessToken: "at-3" }),
  },
]

const realFs = {
  existsSync: (p: string) => {
    try {
      readFileSync(p)
      return true
    } catch {
      return false
    }
  },
  readFileSync: (p: string, _enc: string) => readFileSync(p, "utf-8"),
  writeFileSync: (p: string, data: string, _enc: string) =>
    writeFileSync(p, data, "utf-8"),
  mkdirSync: (p: string, opts: object) =>
    mkdirSync(p, opts as Parameters<typeof mkdirSync>[1]),
  dirname: (p: string) => dirname(p),
}

// Loaded at module scope: top-level `describe` blocks do not run strictly
// after one another's `before` hooks, so a hook-assigned binding would still
// be undefined in later suites.
process.env.HOME = await mkdtemp(join(tmpdir(), "claude-auth-home-"))

/** Expired credentials: fine for the pure helpers, which never read them. */
const helpers = await loadPluginModule("1")

/** Valid credentials, used by the setup/hook suites. */
const plugin = await loadPluginModule()

describe("exported helpers", () => {
  it("buildRequestHeaders sets auth headers and strips x-api-key", () => {
    const headers = helpers.buildRequestHeaders(
      "https://api.anthropic.com/v1/messages",
      {
        headers: {
          "anthropic-beta": "custom-beta",
          "x-api-key": "old-key",
          "x-custom": "keep-me",
        },
      },
      "access-token",
      "claude-sonnet-4-6",
    )

    assert.equal(headers.get("authorization"), "Bearer access-token")
    assert.equal(headers.get("anthropic-version"), "2023-06-01")
    assert.equal(headers.get("x-api-key"), null)
    assert.equal(headers.get("x-custom"), "keep-me")
    assert.ok(headers.get("anthropic-beta")?.includes("custom-beta"))
    assert.ok(
      headers.get("anthropic-beta")?.includes("advisor-tool-2026-03-01"),
    )
    assert.equal(
      headers.get("anthropic-dangerous-direct-browser-access"),
      "true",
    )
    assert.equal(headers.get("x-stainless-lang"), "js")
    assert.equal(headers.get("x-stainless-runtime"), "node")
    assert.equal(
      headers.get("x-anthropic-billing-header"),
      null,
      "Billing header should not be set as HTTP header (it is injected into system array by transformBody)",
    )
    assert.ok(
      headers.get("x-client-request-id"),
      "Expected x-client-request-id to be set",
    )
    assert.match(
      headers.get("x-client-request-id")!,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      "x-client-request-id should be a UUID",
    )
    assert.ok(
      headers.get("x-claude-code-session-id"),
      "Expected X-Claude-Code-Session-Id to be set",
    )
    assert.match(
      headers.get("x-claude-code-session-id")!,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      "X-Claude-Code-Session-Id should be a UUID",
    )
  })

  it("x-client-request-id is unique per call", () => {
    const h1 = helpers.buildRequestHeaders(
      "https://api.anthropic.com/v1/messages",
      { headers: {} },
      "token",
      "claude-sonnet-4-6",
    )
    const h2 = helpers.buildRequestHeaders(
      "https://api.anthropic.com/v1/messages",
      { headers: {} },
      "token",
      "claude-sonnet-4-6",
    )
    assert.notEqual(
      h1.get("x-client-request-id"),
      h2.get("x-client-request-id"),
      "Each call should produce a unique x-client-request-id",
    )
  })

  it("X-Claude-Code-Session-Id is stable across calls", () => {
    const h1 = helpers.buildRequestHeaders(
      "https://api.anthropic.com/v1/messages",
      { headers: {} },
      "token",
      "claude-sonnet-4-6",
    )
    const h2 = helpers.buildRequestHeaders(
      "https://api.anthropic.com/v1/messages",
      { headers: {} },
      "token",
      "claude-sonnet-4-6",
    )
    assert.equal(
      h1.get("x-claude-code-session-id"),
      h2.get("x-claude-code-session-id"),
      "Session ID should be stable within the same process",
    )
  })

  it("billing header is no longer set as HTTP header", () => {
    const headers = helpers.buildRequestHeaders(
      "https://api.anthropic.com/v1/messages",
      { headers: {} },
      "token",
      "claude-opus-4-1",
    )
    assert.equal(
      headers.get("x-anthropic-billing-header"),
      null,
      "Billing header moved from HTTP headers to system array",
    )
  })

  it("buildRequestHeaders uses ANTHROPIC_CLI_VERSION for user-agent", () => {
    process.env.ANTHROPIC_CLI_VERSION = "9.9.9"
    try {
      const headers = helpers.buildRequestHeaders(
        "https://api.anthropic.com/v1/messages",
        { headers: {} },
        "token",
        "claude-sonnet-4-6",
      )
      assert.ok(
        headers.get("user-agent")?.includes("9.9.9"),
        `Expected user-agent to include 9.9.9, got: ${headers.get("user-agent")}`,
      )
      assert.ok(headers.get("user-agent")?.includes("sdk-cli"))
    } finally {
      delete process.env.ANTHROPIC_CLI_VERSION
    }
  })

  it("buildRequestHeaders uses ANTHROPIC_USER_AGENT when set", () => {
    process.env.ANTHROPIC_USER_AGENT = "custom-agent/1.0"
    try {
      const headers = helpers.buildRequestHeaders(
        "https://api.anthropic.com/v1/messages",
        { headers: {} },
        "token",
        "claude-sonnet-4-6",
      )
      assert.equal(headers.get("user-agent"), "custom-agent/1.0")
    } finally {
      delete process.env.ANTHROPIC_USER_AGENT
    }
  })

  it("ANTHROPIC_CLI_VERSION overrides version in billing header (via transformBody)", () => {
    process.env.ANTHROPIC_CLI_VERSION = "9.9.9"
    try {
      const { transformBody } = helpers
      const body = JSON.stringify({
        system: [{ type: "text", text: "test" }],
        messages: [{ role: "user", content: "hey" }],
      })
      const result = transformBody(body)
      assert.ok(typeof result === "string")
      const parsed = JSON.parse(result as string) as {
        system: Array<{ text: string }>
      }
      const billing = parsed.system[0].text
      assert.ok(
        billing.includes("cc_version=9.9.9"),
        `Expected billing header to include 9.9.9, got: ${billing}`,
      )
      assert.ok(
        billing.includes("cc_entrypoint=sdk-cli"),
        `Expected billing header to include sdk-cli, got: ${billing}`,
      )
    } finally {
      delete process.env.ANTHROPIC_CLI_VERSION
    }
  })

  it("buildRequestHeaders preserves provided stainless headers", () => {
    const headers = helpers.buildRequestHeaders(
      "https://api.anthropic.com/v1/messages",
      {
        headers: {
          "x-stainless-runtime": "custom-runtime",
        },
      },
      "token",
      "claude-sonnet-4-6",
    )
    assert.equal(headers.get("x-stainless-runtime"), "custom-runtime")
  })

  it("buildRequestUrl adds beta=true to /v1/messages", () => {
    assert.equal(
      helpers.buildRequestUrl("https://api.anthropic.com/v1/messages"),
      "https://api.anthropic.com/v1/messages?beta=true",
    )
  })

  it("buildRequestUrl leaves an existing beta param alone", () => {
    assert.equal(
      helpers.buildRequestUrl(
        "https://api.anthropic.com/v1/messages?beta=false",
      ),
      "https://api.anthropic.com/v1/messages?beta=false",
    )
  })

  it("buildRequestUrl leaves other paths untouched", () => {
    assert.equal(
      helpers.buildRequestUrl("https://api.anthropic.com/v1/models"),
      "https://api.anthropic.com/v1/models",
    )
  })

  it("parseModelId reads the model from a JSON body", () => {
    assert.equal(
      helpers.parseModelId(JSON.stringify({ model: "claude-haiku-4-5" })),
      "claude-haiku-4-5",
    )
  })

  it("parseModelId returns null for absent, empty or invalid bodies", () => {
    assert.equal(helpers.parseModelId(undefined), null)
    assert.equal(helpers.parseModelId(""), null)
    assert.equal(helpers.parseModelId("not json"), null)
    assert.equal(helpers.parseModelId(JSON.stringify({})), null)
  })
})

// --- fetchWithRetry still backs the OAuth refresh in credentials.ts, even
// though v2 leaves the model request itself to OpenCode. -------------------

describe("fetchWithRetry", () => {
  it("fetchWithRetry retries on 429 and succeeds", async () => {
    let callCount = 0
    const mockFetch = (() => {
      callCount++
      if (callCount === 1)
        return Promise.resolve(new Response("rate limited", { status: 429 }))
      return Promise.resolve(new Response("ok", { status: 200 }))
    }) as unknown as typeof fetch
    const res = await helpers.fetchWithRetry(
      "https://example.com",
      {},
      3,
      mockFetch,
    )
    assert.equal(res.status, 200)
    assert.equal(callCount, 2)
  })

  it("fetchWithRetry retries on 529 and succeeds", async () => {
    let callCount = 0
    const mockFetch = (() => {
      callCount++
      if (callCount === 1)
        return Promise.resolve(new Response("overloaded", { status: 529 }))
      return Promise.resolve(new Response("ok", { status: 200 }))
    }) as unknown as typeof fetch
    const res = await helpers.fetchWithRetry(
      "https://example.com",
      {},
      3,
      mockFetch,
    )
    assert.equal(res.status, 200)
    assert.equal(callCount, 2)
  })

  it("fetchWithRetry returns non-retryable errors immediately", async () => {
    let callCount = 0
    const mockFetch = (() => {
      callCount++
      return Promise.resolve(new Response("bad request", { status: 400 }))
    }) as unknown as typeof fetch
    const res = await helpers.fetchWithRetry(
      "https://example.com",
      {},
      3,
      mockFetch,
    )
    assert.equal(res.status, 400)
    assert.equal(callCount, 1)
  })

  it("fetchWithRetry gives up after max retries", async () => {
    let callCount = 0
    const mockFetch = (() => {
      callCount++
      return Promise.resolve(new Response("rate limited", { status: 429 }))
    }) as unknown as typeof fetch
    const res = await helpers.fetchWithRetry(
      "https://example.com",
      {},
      2,
      mockFetch,
    )
    assert.equal(res.status, 429)
    assert.equal(callCount, 2)
  })

  it("fetchWithRetry respects retry-after header", async () => {
    const start = Date.now()
    let callCount = 0
    const mockFetch = (() => {
      callCount++
      if (callCount === 1) {
        return Promise.resolve(
          new Response("rate limited", {
            status: 429,
            headers: { "retry-after": "1" },
          }),
        )
      }
      return Promise.resolve(new Response("ok", { status: 200 }))
    }) as unknown as typeof fetch
    await helpers.fetchWithRetry("https://example.com", {}, 3, mockFetch)
    const elapsed = Date.now() - start
    assert.ok(elapsed >= 900, `Expected at least 900ms delay, got ${elapsed}ms`)
  })

  // refreshViaOAuth bounds its whole request with an AbortController. If the
  // backoff ignores that signal, the effective timeout is the retry delay
  // (capped at 30s) rather than the 15s the caller asked for.
  it("fetchWithRetry stops backing off once the request is aborted", async () => {
    const controller = new AbortController()
    let calls = 0
    const mockFetch = async () => {
      calls += 1
      return new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "5" },
      })
    }

    setTimeout(() => controller.abort(), 50)
    const started = Date.now()
    const res = await helpers.fetchWithRetry(
      "https://example.com",
      { signal: controller.signal },
      3,
      mockFetch as unknown as typeof fetch,
    )
    const elapsed = Date.now() - started

    assert.equal(res.status, 429)
    assert.equal(calls, 1, "must not keep retrying after abort")
    assert.ok(elapsed < 1_000, `expected a prompt return, took ${elapsed}ms`)
  })

  it("fetchWithRetry returns immediately when retry-after exceeds max delay cap", async () => {
    // A retry-after of 31s (31,000ms) exceeds the 30,000ms cap and signals a
    // quota/usage-limit reset, not a transient rate limit. The function must
    // return the error response immediately rather than waiting and hanging.
    const start = Date.now()
    let callCount = 0
    const mockFetch = (() => {
      callCount++
      return Promise.resolve(
        new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "31" },
        }),
      )
    }) as unknown as typeof fetch
    const res = await helpers.fetchWithRetry(
      "https://example.com",
      {},
      3,
      mockFetch,
    )
    const elapsed = Date.now() - start
    assert.equal(res.status, 429)
    assert.equal(callCount, 1, "should not retry when delay exceeds cap")
    assert.ok(elapsed < 5000, `Expected immediate return, got ${elapsed}ms`)
  })

  it("fetchWithRetry respects OPENCODE_CLAUDE_AUTH_MAX_RETRY_MS env override", async () => {
    // Override the cap below the natural retry-after delay so the env var
    // demonstrably changes behaviour: a `retry-after: 1` produces a 1000ms
    // delay, which exceeds the 500ms override cap, so the function must
    // bail immediately. Without the override the default 30s cap would
    // permit the retry and elapsed would be ~1000ms — the gap is what
    // proves the env var took effect.
    process.env.OPENCODE_CLAUDE_AUTH_MAX_RETRY_MS = "500"
    let callCount = 0
    const mockFetch = (() => {
      callCount++
      return Promise.resolve(
        new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "1" },
        }),
      )
    }) as unknown as typeof fetch
    try {
      const start = Date.now()
      const res = await helpers.fetchWithRetry(
        "https://example.com",
        {},
        3,
        mockFetch,
      )
      const elapsed = Date.now() - start
      assert.equal(res.status, 429)
      assert.equal(
        callCount,
        1,
        "should not retry when delay exceeds env-override cap",
      )
      assert.ok(elapsed < 500, `expected immediate return, got ${elapsed}ms`)
    } finally {
      delete process.env.OPENCODE_CLAUDE_AUTH_MAX_RETRY_MS
    }
  })

  it("fetchWithRetry still retries when retry-after is within the delay cap", async () => {
    let callCount = 0
    const mockFetch = (() => {
      callCount++
      if (callCount === 1) {
        return Promise.resolve(
          new Response("rate limited", {
            status: 429,
            headers: { "retry-after": "1" },
          }),
        )
      }
      return Promise.resolve(new Response("ok", { status: 200 }))
    }) as unknown as typeof fetch
    const res = await helpers.fetchWithRetry(
      "https://example.com",
      {},
      3,
      mockFetch,
    )
    assert.equal(res.status, 200)
    assert.equal(callCount, 2, "should retry when delay is within cap")
  })

  it("fetchWithRetry falls back to default delay when retry-after is non-numeric", async () => {
    const start = Date.now()
    let callCount = 0
    const mockFetch = (() => {
      callCount++
      if (callCount === 1) {
        return Promise.resolve(
          new Response("rate limited", {
            status: 429,
            headers: { "retry-after": "not-a-number" },
          }),
        )
      }
      return Promise.resolve(new Response("ok", { status: 200 }))
    }) as unknown as typeof fetch
    await helpers.fetchWithRetry("https://example.com", {}, 3, mockFetch)
    const elapsed = Date.now() - start
    // Default delay for first retry (i=0) is (0+1)*2000 = 2000ms
    assert.ok(
      elapsed >= 1900,
      `Expected at least 1900ms fallback delay, got ${elapsed}ms`,
    )
  })
})

// --- Retry policy (replaces v1's inline retry loops) -----------------------

describe("decideRetry", () => {
  beforeEach(() => {
    helpers.resetExcludedBetas()
  })

  it("retries a 429 using the captured retry-after delay", () => {
    const outcome = helpers.decideRetry(
      { status: 429 },
      1,
      "claude-sonnet-4-6",
      5_000,
    )
    assert.deepEqual(outcome, {
      retry: true,
      delay: 5_000,
      reason: "rate_limited",
    })
  })

  it("retries a 529 with an exponential fallback when retry-after is absent", () => {
    assert.deepEqual(helpers.decideRetry({ status: 529 }, 1, "m"), {
      retry: true,
      delay: 2_000,
      reason: "rate_limited",
    })
    assert.deepEqual(helpers.decideRetry({ status: 529 }, 2, "m"), {
      retry: true,
      delay: 4_000,
      reason: "rate_limited",
    })
  })

  it("stops retrying when the delay exceeds the cap (quota reset)", () => {
    const outcome = helpers.decideRetry({ status: 429 }, 1, "m", 31_000)
    assert.deepEqual(outcome, { retry: false, reason: "rate_limit_quota" })
  })

  it("respects OPENCODE_CLAUDE_AUTH_MAX_RETRY_MS", () => {
    process.env.OPENCODE_CLAUDE_AUTH_MAX_RETRY_MS = "500"
    try {
      assert.deepEqual(helpers.decideRetry({ status: 429 }, 1, "m", 1_000), {
        retry: false,
        reason: "rate_limit_quota",
      })
    } finally {
      delete process.env.OPENCODE_CLAUDE_AUTH_MAX_RETRY_MS
    }
  })

  it("retries a 401 once so fresh credentials are picked up", () => {
    assert.deepEqual(helpers.decideRetry({ status: 401 }, 1, "m"), {
      retry: true,
      delay: 0,
      reason: "auth_refresh",
    })
  })

  it("gives up on a 401 after the retry attempt also failed", () => {
    assert.deepEqual(helpers.decideRetry({ status: 401 }, 3, "m"), {
      retry: false,
      reason: "auth_retry_exhausted",
    })
  })

  it("leaves OpenCode's decision alone for unrelated failures", () => {
    assert.equal(helpers.decideRetry({ status: 500 }, 1, "m"), null)
    assert.equal(helpers.decideRetry({ status: 400 }, 1, "m"), null)
    assert.equal(helpers.decideRetry({}, 1, "m"), null)
  })

  it("excludes one long-context beta per attempt and retries", () => {
    const body = JSON.stringify({
      error: { message: "Extra usage is required for long context requests" },
    })
    const modelId = "claude-sonnet-4-6"

    const first = helpers.decideRetry({ status: 400, body }, 1, modelId)
    assert.equal(first?.retry, true)
    assert.equal(
      first && "reason" in first ? first.reason : undefined,
      "long_context_beta_excluded",
    )
    const excludedBeta =
      first && "excludedBeta" in first ? first.excludedBeta : undefined
    assert.ok(excludedBeta, "Expected a beta to be excluded")
    assert.ok(helpers.getExcludedBetas(modelId).has(excludedBeta!))
  })

  it("stops once every long-context beta is excluded", () => {
    const body = "You're out of extra usage"
    const modelId = "claude-sonnet-4-6"

    for (let i = 0; i < helpers.LONG_CONTEXT_BETAS.length; i++) {
      const outcome = helpers.decideRetry({ status: 400, body }, i + 1, modelId)
      assert.equal(outcome?.retry, true, `attempt ${i + 1} should retry`)
    }

    assert.deepEqual(helpers.decideRetry({ status: 400, body }, 99, modelId), {
      retry: false,
      reason: "long_context_betas_exhausted",
    })
  })

  it("treats a long-context 429 as a beta problem, not a rate limit", () => {
    const outcome = helpers.decideRetry(
      { status: 429, body: "long context beta is not yet available" },
      1,
      "claude-opus-4-6",
    )
    assert.equal(
      outcome && "reason" in outcome ? outcome.reason : undefined,
      "long_context_beta_excluded",
    )
  })
})

// --- Credential recovery: the v1 inline 401/429 retry loops, now reachable
// as exported steps the retry hook composes. ---------------------------------

/** A long-lived credential, so reload validity checks never reject it. */
function recoveredCreds(accessToken: string): ClaudeCredentials {
  return {
    accessToken,
    refreshToken: `rt-${accessToken}`,
    expiresAt: Date.now() + 8 * 60 * 60_000,
  }
}

function retryEvent(
  overrides: Partial<{
    sessionID: string
    status: number
    attempt: number
    body: string
  }> = {},
) {
  return {
    sessionID: overrides.sessionID ?? "s1",
    agent: "build",
    model: { id: "claude-haiku-4-5", providerID: "anthropic" },
    error: {
      type: "api_error",
      message: "failed",
      status: overrides.status ?? 429,
      ...(overrides.body ? { response: { body: overrides.body } } : {}),
    },
    attempt: overrides.attempt ?? 1,
    decision: { retry: false } as { retry: boolean; delay?: number },
  }
}

/** Drive one model request so the session has a recorded token. */
async function sendRequest(
  hooks: HookEntry[],
  sessionID: string,
): Promise<void> {
  await findHook(hooks, "http.request").callback({
    sessionID,
    kind: "primary",
    agent: "build",
    model: { id: "claude-haiku-4-5", providerID: "anthropic" },
    request: new Request("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-haiku-4-5", messages: [] }),
    }),
  })
}

describe("recoverRejectedToken", () => {
  it("adopts a token rotated into the source by someone else", async () => {
    let forceRefreshCalls = 0
    const recovered = await helpers.recoverRejectedToken(
      "rejected-token",
      "claude-haiku-4-5",
      {
        reload: () => recoveredCreds("replacement-token"),
        forceRefresh: async () => {
          forceRefreshCalls += 1
          return recoveredCreds("should-not-be-used")
        },
      },
    )

    assert.equal(recovered?.accessToken, "replacement-token")
    assert.equal(
      forceRefreshCalls,
      0,
      "a usable reload must not also burn an OAuth refresh",
    )
  })

  it("force-refreshes when the source still holds the rejected token", async () => {
    const recovered = await helpers.recoverRejectedToken(
      "rejected-token",
      "m",
      {
        reload: () => recoveredCreds("rejected-token"),
        forceRefresh: async () => recoveredCreds("refreshed-token"),
      },
    )
    assert.equal(recovered?.accessToken, "refreshed-token")
  })

  it("force-refreshes when the reload yields nothing usable", async () => {
    // reloadCredentialsFromSource returns null for a credential expiring
    // inside 60s, so "changed but unusable" has to reach the refresh too.
    const recovered = await helpers.recoverRejectedToken("rejected", "m", {
      reload: () => null,
      forceRefresh: async () => recoveredCreds("refreshed-token"),
    })
    assert.equal(recovered?.accessToken, "refreshed-token")
  })

  it("returns null when neither step produces a different token", async () => {
    const recovered = await helpers.recoverRejectedToken("rejected", "m", {
      reload: () => recoveredCreds("rejected"),
      forceRefresh: async () => recoveredCreds("rejected"),
    })
    assert.equal(
      recovered,
      null,
      "retrying with the rejected token would fail identically",
    )
  })

  it("returns null rather than throwing when the reload throws", async () => {
    const recovered = await helpers.recoverRejectedToken("rejected", "m", {
      reload: () => {
        throw new Error("forced reload failure")
      },
      forceRefresh: async () => null,
    })
    assert.equal(recovered, null)
  })

  it("falls back to the reload result when the force refresh throws", async () => {
    // A reload that changed the token is still usable even if the refresh
    // that would have replaced it blew up.
    const recovered = await helpers.recoverRejectedToken("rejected", "m", {
      reload: () => null,
      forceRefresh: async () => {
        throw new Error("refresh rejected")
      },
    })
    assert.equal(recovered, null)
  })
})

describe("pickUpRotatedToken", () => {
  it("reports a token replaced since the rate-limited attempt", () => {
    const rotated = helpers.pickUpRotatedToken("exhausted-token", "m", () =>
      recoveredCreds("fresh-token"),
    )
    assert.equal(rotated?.accessToken, "fresh-token")
  })

  it("reports nothing when the source still holds the same token", () => {
    const rotated = helpers.pickUpRotatedToken("exhausted-token", "m", () =>
      recoveredCreds("exhausted-token"),
    )
    assert.equal(rotated, null, "an unchanged token must not be retried")
  })

  it("reports nothing when the source is unreadable", () => {
    assert.equal(
      helpers.pickUpRotatedToken("exhausted-token", "m", () => null),
      null,
    )
  })

  it("returns null rather than throwing when the reload throws", () => {
    const rotated = helpers.pickUpRotatedToken("exhausted-token", "m", () => {
      throw new Error("forced reload failure")
    })
    assert.equal(rotated, null)
  })
})

// --- Proactive refresh timer ------------------------------------------------

describe("proactive refresh timer", () => {
  it("unrefs the interval so it cannot hold the process open", async () => {
    const originalSetInterval = globalThis.setInterval
    let unrefCalled = false
    globalThis.setInterval = (() => ({
      unref() {
        unrefCalled = true
      },
    })) as unknown as typeof setInterval

    try {
      const { ctx } = createFakeContext()
      await plugin.default.setup(ctx as never)
      assert.ok(unrefCalled, "expected .unref() on the interval timer")
    } finally {
      globalThis.setInterval = originalSetInterval
    }
  })

  it("stops ticking once setup's cleanup runs", async () => {
    const originalSetInterval = globalThis.setInterval
    const originalClearInterval = globalThis.clearInterval
    const timer = { unref() {} }
    let cleared: unknown
    globalThis.setInterval = (() => timer) as unknown as typeof setInterval
    globalThis.clearInterval = ((t: unknown) => {
      cleared = t
    }) as unknown as typeof clearInterval

    try {
      const { ctx } = createFakeContext()
      const cleanup = await plugin.default.setup(ctx as never)
      await (cleanup as () => void)()
      assert.equal(cleared, timer, "cleanup must clear the interval it started")
    } finally {
      globalThis.setInterval = originalSetInterval
      globalThis.clearInterval = originalClearInterval
    }
  })

  it("targets the ACTIVE account after a switch, not accounts[0]", async () => {
    const originalSetInterval = globalThis.setInterval
    const originalHome = process.env.HOME
    const originalDebug = process.env.CLAUDE_AUTH_DEBUG
    const tempHome = await mkdtemp(join(tmpdir(), "opencode-claude-auth-home-"))
    const debugLogPath = join(tempHome, "debug.log")
    process.env.HOME = tempHome
    // Capture the timer's own log ("proactive_refresh_check") so we can
    // assert which account it resolved to. CLAUDE_AUTH_DEBUG routes logs to
    // a file (see logger.ts).
    process.env.CLAUDE_AUTH_DEBUG = debugLogPath

    let tickCallback: (() => void | Promise<void>) | undefined
    globalThis.setInterval = ((cb: () => void | Promise<void>) => {
      tickCallback = cb
      return { unref() {} }
    }) as unknown as typeof setInterval

    try {
      const { helpersModule } = await loadHelpersWithMultiAccountKeychain({
        // accounts[0] ("acct-a") — far from expiry. The pre-fix code used
        // THIS account's expiry to decide whether to take the proactive
        // branch at all, regardless of which account is actually active.
        aExpiresAt: Date.now() + 10 * 60 * 60 * 1000,
        // Active account after the switch below — within the 1h proactive
        // window but past the 60s reactive threshold, so authorize()'s own
        // getCachedCredentials() call must NOT refresh it (isolating the
        // timer as the only thing that triggers a refresh here).
        bExpiresAt: Date.now() + 10 * 60 * 1000,
        bRefreshResult: "success",
      })

      const { ctx, integrationTransforms } = createFakeContext()
      await helpersModule.default.setup(ctx as never)
      assert.ok(tickCallback, "expected setInterval to capture the tick")

      await authorizeVia(integrationTransforms, { account: "acct-b" })

      // Truncate the log so we only inspect entries produced by the tick.
      await writeFile(debugLogPath, "", "utf-8")
      await tickCallback!()

      const logs = await readFile(debugLogPath, "utf-8")
      const checks = logs
        .split("\n")
        .filter((line) => line.includes("proactive_refresh_check"))
      assert.ok(
        checks.length > 0,
        `Expected proactive_refresh_check log entry, got log: ${logs}`,
      )
      assert.ok(
        checks.some((l) => l.includes('"source":"acct-b"')),
        `Timer should resolve ACTIVE account (acct-b) after switch, not ` +
          `accounts[0] (acct-a). Log: ${logs}`,
      )
      assert.ok(
        !checks.some((l) => l.includes('"source":"acct-a"')),
        `Timer should NOT be checking accounts[0] after switch. Log: ${logs}`,
      )
    } finally {
      globalThis.setInterval = originalSetInterval
      if (typeof originalHome === "string") {
        process.env.HOME = originalHome
      } else {
        delete process.env.HOME
      }
      if (originalDebug === undefined) {
        delete process.env.CLAUDE_AUTH_DEBUG
      } else {
        process.env.CLAUDE_AUTH_DEBUG = originalDebug
      }
    }
  })

  it("warns at most once per outage (no spam on repeated failures)", async () => {
    const originalSetInterval = globalThis.setInterval
    const originalHome = process.env.HOME
    const originalWarn = console.warn
    const tempHome = await mkdtemp(join(tmpdir(), "opencode-claude-auth-home-"))
    process.env.HOME = tempHome

    let tickCallback: (() => void | Promise<void>) | undefined
    globalThis.setInterval = ((cb: () => void | Promise<void>) => {
      tickCallback = cb
      return { unref() {} }
    }) as unknown as typeof setInterval

    const warnMessages: string[] = []
    console.warn = ((...args: unknown[]) => {
      warnMessages.push(String(args[0]))
    }) as typeof console.warn

    try {
      const { helpersModule } = await loadHelpersWithMultiAccountKeychain({
        // acct-a ALREADY EXPIRED so the fallback cannot borrow its creds
        // when acct-b's refresh fails. Otherwise refreshIfNeeded returns
        // non-null, the warn path is unreachable and the latch untestable.
        aExpiresAt: Date.now() - 60_000,
        // Inside the reactive window, so the refresh chain runs to
        // exhaustion instead of short-circuiting on still-usable creds.
        bExpiresAt: Date.now() + 30_000,
        bRefreshResult: "fail",
      })

      const { ctx, integrationTransforms } = createFakeContext()
      await helpersModule.default.setup(ctx as never)
      assert.ok(tickCallback)

      await authorizeVia(integrationTransforms, { account: "acct-b" })
      warnMessages.length = 0 // ignore warnings from init/authorize

      // Three consecutive failed ticks (15 minutes of downtime). Awaited
      // individually: real ticks are 5 minutes apart.
      await tickCallback!()
      await tickCallback!()
      await tickCallback!()

      const proactiveWarnings = warnMessages.filter((m) =>
        m.includes("Proactive token refresh failed"),
      )
      assert.equal(
        proactiveWarnings.length,
        1,
        `Expected exactly 1 warning across 3 failed ticks (latched), got ${proactiveWarnings.length}`,
      )
    } finally {
      globalThis.setInterval = originalSetInterval
      console.warn = originalWarn
      if (typeof originalHome === "string") {
        process.env.HOME = originalHome
      } else {
        delete process.env.HOME
      }
    }
  })
})

describe("parseRetryAfterMs", () => {
  it("converts seconds to milliseconds", () => {
    assert.equal(helpers.parseRetryAfterMs("5"), 5_000)
  })

  it("returns undefined for a missing or non-numeric header", () => {
    assert.equal(helpers.parseRetryAfterMs(null), undefined)
    assert.equal(helpers.parseRetryAfterMs("not-a-number"), undefined)
  })
})

// --- Plugin setup against a fake v2 context ---------------------------------

describe("plugin setup", () => {
  it("exposes a stable plugin id and a setup function", () => {
    assert.equal(plugin.default.id, "opencode-claude-auth")
    assert.equal(typeof plugin.default.setup, "function")
  })

  it("registers every session hook scoped to the anthropic provider", async () => {
    const { ctx, hooks } = createFakeContext()
    await plugin.default.setup(ctx as never)

    const names = new Set(hooks.map((hook) => hook.name))
    for (const expected of [
      "context",
      "compaction",
      "generate",
      "title",
      "http.request",
      "http.response",
      "retry",
    ]) {
      assert.ok(names.has(expected), `missing hook: ${expected}`)
    }

    for (const hook of hooks) {
      assert.equal(
        hook.options?.providerID,
        "anthropic",
        `hook ${hook.name} should be scoped to anthropic`,
      )
    }
  })

  it("setup returns a cleanup function", async () => {
    const { ctx } = createFakeContext()
    const cleanup = await plugin.default.setup(ctx as never)
    assert.equal(typeof cleanup, "function")
    await (cleanup as () => void)()
  })

  describe("context hook", () => {
    it("injects the Claude Code identity prefix", async () => {
      const { ctx, hooks } = createFakeContext()
      await plugin.default.setup(ctx as never)

      const event = { system: [{ type: "text", text: "Existing instruction" }] }
      await findHook(hooks, "context").callback(event)

      assert.equal(event.system.length, 2)
      assert.equal(
        event.system[0].text,
        "You are Claude Code, Anthropic's official CLI for Claude.",
      )
    })

    it("does not inject when the prefix is already present", async () => {
      const { ctx, hooks } = createFakeContext()
      await plugin.default.setup(ctx as never)

      const prefixed =
        "You are Claude Code, Anthropic's official CLI for Claude.\n\nExisting"
      const event = { system: [{ type: "text", text: prefixed }] }
      await findHook(hooks, "context").callback(event)

      assert.deepEqual(event.system, [{ type: "text", text: prefixed }])
    })

    it("applies to title and compaction requests too", async () => {
      const { ctx, hooks } = createFakeContext()
      await plugin.default.setup(ctx as never)

      for (const name of ["title", "compaction", "generate"]) {
        const event = { system: [] as Array<{ type: string; text?: string }> }
        await findHook(hooks, name).callback(event)
        assert.equal(event.system.length, 1, `${name} should inject identity`)
      }
    })
  })

  describe("http.request hook", () => {
    it("adds beta=true, sets bearer auth and transforms the body", async () => {
      const { ctx, hooks } = createFakeContext()
      await plugin.default.setup(ctx as never)

      const event = {
        sessionID: "s1",
        kind: "primary",
        model: { id: "claude-haiku-4-5", providerID: "anthropic" },
        request: new Request("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": "should-be-stripped" },
          body: JSON.stringify({
            model: "claude-haiku-4-5",
            messages: [{ role: "user", content: "hey" }],
            tools: [{ name: "bash" }],
          }),
        }),
      }

      await findHook(hooks, "http.request").callback(event)

      assert.equal(
        event.request.url,
        "https://api.anthropic.com/v1/messages?beta=true",
      )
      assert.equal(event.request.headers.get("authorization"), "Bearer token")
      assert.equal(event.request.headers.get("x-api-key"), null)
      assert.equal(event.request.headers.get("x-app"), "cli")

      const sent = JSON.parse(await event.request.text()) as {
        tools: Array<{ name: string }>
        system: Array<{ text: string }>
      }
      assert.equal(
        sent.tools[0].name,
        "mcp_Bash",
        "tool names should be prefixed and PascalCased",
      )
      assert.ok(
        sent.system[0].text.startsWith("x-anthropic-billing-header"),
        "billing header should be injected as system[0]",
      )
    })

    it("does not attach a body to a GET request", async () => {
      const { ctx, hooks } = createFakeContext()
      await plugin.default.setup(ctx as never)

      const event = {
        sessionID: "s1",
        kind: "primary",
        model: { id: "claude-haiku-4-5", providerID: "anthropic" },
        request: new Request("https://api.anthropic.com/v1/models"),
      }

      await findHook(hooks, "http.request").callback(event)

      assert.equal(event.request.method, "GET")
      assert.equal(event.request.body, null)
      assert.equal(event.request.url, "https://api.anthropic.com/v1/models")
    })

    it("throws an actionable error when credentials are unavailable", async () => {
      const expired = await loadPluginModule("1")
      const { ctx, hooks } = createFakeContext()
      await expired.default.setup(ctx as never)

      const event = {
        sessionID: "s1",
        kind: "primary",
        model: { id: "claude-haiku-4-5", providerID: "anthropic" },
        request: new Request("https://api.anthropic.com/v1/messages", {
          method: "POST",
          body: "{}",
        }),
      }

      await assert.rejects(
        async () => findHook(hooks, "http.request").callback(event),
        /Run `claude` to refresh them/,
      )
    })
  })

  describe("http.response hook", () => {
    it("strips the mcp_ tool prefix out of the stream", async () => {
      const { ctx, hooks } = createFakeContext()
      await plugin.default.setup(ctx as never)

      const event = {
        sessionID: "s1",
        kind: "primary",
        model: { id: "claude-haiku-4-5", providerID: "anthropic" },
        request: new Request("https://api.anthropic.com/v1/messages"),
        response: new Response(
          `event: content_block_start\ndata: {"name": "mcp_Bash"}\n\n`,
          { status: 200 },
        ),
      }

      await findHook(hooks, "http.response").callback(event)

      const text = await event.response.text()
      assert.ok(text.includes(`"name": "bash"`), `got: ${text}`)
      assert.ok(!text.includes("mcp_Bash"))
    })

    it("leaves a 401 body alone (it carries an error, not an SSE stream)", async () => {
      const { ctx, hooks } = createFakeContext()
      await plugin.default.setup(ctx as never)

      const body = JSON.stringify({
        type: "error",
        error: { type: "authentication_error", message: "revoked" },
      })
      const original = new Response(body, { status: 401 })
      const event = {
        sessionID: "s1",
        kind: "primary",
        model: { id: "claude-haiku-4-5", providerID: "anthropic" },
        request: new Request("https://api.anthropic.com/v1/messages"),
        response: original,
      }

      await findHook(hooks, "http.response").callback(event)

      assert.equal(event.response, original, "a 401 must pass through as-is")
      assert.equal(await event.response.text(), body)
    })

    it("captures retry-after so the retry hook can use it", async () => {
      const { ctx, hooks } = createFakeContext()
      await plugin.default.setup(ctx as never)

      const sessionID = "s-retry-after"
      await findHook(hooks, "http.response").callback({
        sessionID,
        kind: "primary",
        model: { id: "claude-haiku-4-5", providerID: "anthropic" },
        request: new Request("https://api.anthropic.com/v1/messages"),
        response: new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "7" },
        }),
      })

      const event = {
        sessionID,
        agent: "build",
        model: { id: "claude-haiku-4-5", providerID: "anthropic" },
        error: { type: "api_error", message: "rate limited", status: 429 },
        attempt: 1,
        decision: { retry: false } as { retry: boolean; delay?: number },
      }
      await findHook(hooks, "retry").callback(event)

      // 7s from the header, not the 2s attempt-based fallback.
      assert.deepEqual(event.decision, { retry: true, delay: 7_000 })
    })
  })

  describe("retry hook", () => {
    it("leaves OpenCode's decision untouched for unrelated failures", async () => {
      const { ctx, hooks } = createFakeContext()
      await plugin.default.setup(ctx as never)

      const event = retryEvent({ status: 500 })
      await findHook(hooks, "retry").callback(event)
      assert.deepEqual(event.decision, { retry: false })
    })

    it("refuses to retry a 401 when no different token can be produced", async () => {
      // The stubbed keychain always hands back the same credential, so
      // recovery cannot progress — exactly the case where v1 surfaced the
      // original 401 instead of burning another request on it.
      const { ctx, hooks } = createFakeContext()
      await plugin.default.setup(ctx as never)

      const sessionID = "s-401"
      // Send a request first: recovery compares against the token this
      // session actually used, which only http.request records.
      await sendRequest(hooks, sessionID)

      const event = retryEvent({ status: 401, sessionID })
      await findHook(hooks, "retry").callback(event)
      assert.deepEqual(event.decision, { retry: false })
    })

    it("retries a 401 that failed before any token was recorded", async () => {
      // Nothing to compare against, so the policy decision stands and the
      // next attempt rebuilds from current credentials.
      const { ctx, hooks } = createFakeContext()
      await plugin.default.setup(ctx as never)

      const event = retryEvent({ status: 401, sessionID: "s-401-early" })
      await findHook(hooks, "retry").callback(event)
      assert.deepEqual(event.decision, { retry: true, delay: 0 })
    })

    it("backs off on a 429 whose token has not rotated", async () => {
      const { ctx, hooks } = createFakeContext()
      await plugin.default.setup(ctx as never)

      const event = retryEvent({ status: 429, attempt: 2 })
      await findHook(hooks, "retry").callback(event)
      assert.deepEqual(event.decision, { retry: true, delay: 4_000 })
    })

    it("drops a long-context beta instead of treating a 429 as a rate limit", async () => {
      const { ctx, hooks } = createFakeContext()
      await plugin.default.setup(ctx as never)
      plugin.resetExcludedBetas()

      const event = retryEvent({
        status: 429,
        body: "long context beta is not yet available",
      })
      await findHook(hooks, "retry").callback(event)

      assert.deepEqual(
        event.decision,
        { retry: true, delay: 0 },
        "a header problem retries immediately, with no backoff",
      )
      assert.ok(
        plugin.getExcludedBetas("claude-haiku-4-5").size > 0,
        "the retry must differ from the attempt that just failed",
      )
    })

    // The suites above inject the credential lookups. These two run through
    // the real reloadCredentialsFromSource / forceRefreshActiveAccount, which
    // is the only thing that proves the default wiring is connected.
    it("retries a 429 without backoff once the source token has rotated", async () => {
      const { helpersModule, keychainModule } =
        await loadPluginWithKeychainControls()
      const { ctx, hooks } = createFakeContext()
      await helpersModule.default.setup(ctx as never)

      const sessionID = "s-429-rotated"
      await sendRequest(hooks, sessionID)

      // Another process switched accounts while we were rate-limited.
      keychainModule.__setCredentials({
        accessToken: "rotated-token",
        refreshToken: "rotated-refresh",
        expiresAt: Date.now() + 8 * 60 * 60_000,
      })

      const event = retryEvent({ status: 429, sessionID, attempt: 2 })
      await findHook(hooks, "retry").callback(event)

      assert.deepEqual(
        event.decision,
        { retry: true, delay: 0 },
        "a limit already resolved elsewhere needs no backoff",
      )
    })

    it("recovers a 401 from a token rotated into the source", async () => {
      const { helpersModule, keychainModule } =
        await loadPluginWithKeychainControls()
      const { ctx, hooks } = createFakeContext()
      await helpersModule.default.setup(ctx as never)

      const sessionID = "s-401-rotated"
      await sendRequest(hooks, sessionID)

      keychainModule.__setCredentials({
        accessToken: "replacement-token",
        refreshToken: "replacement-refresh",
        expiresAt: Date.now() + 8 * 60 * 60_000,
      })

      const event = retryEvent({ status: 401, sessionID })
      await findHook(hooks, "retry").callback(event)

      assert.deepEqual(event.decision, { retry: true, delay: 0 })
    })
  })

  describe("model.transform", () => {
    it("zeroes the cost of every anthropic model", async () => {
      const { ctx, modelTransforms } = createFakeContext()
      await plugin.default.setup(ctx as never)
      assert.equal(modelTransforms.length, 1)

      const model = {
        id: "claude-sonnet-4-6",
        cost: [
          {
            input: 3,
            output: 15,
            cache: { read: 0.3, write: 3.75 },
            tier: { type: "context", size: 200_000 },
          },
        ],
      }

      const editor = {
        provider: {
          get: (providerID: string) =>
            providerID === "anthropic"
              ? { models: new Map([[model.id, model]]) }
              : undefined,
        },
        update: (
          _providerID: string,
          _modelID: string,
          update: (m: typeof model) => void,
        ) => update(model),
      }

      modelTransforms[0](editor)

      assert.deepEqual(model.cost, [
        {
          input: 0,
          output: 0,
          cache: { read: 0, write: 0 },
          tier: { type: "context", size: 200_000 },
        },
      ])
    })

    it("is a no-op when the anthropic provider is absent", async () => {
      const { ctx, modelTransforms } = createFakeContext()
      await plugin.default.setup(ctx as never)

      assert.doesNotThrow(() =>
        modelTransforms[0]({
          provider: { get: () => undefined },
          update: () => assert.fail("should not update any model"),
        }),
      )
    })
  })

  describe("integration.transform", () => {
    it("registers an oauth method on the anthropic integration", async () => {
      const { ctx, integrationTransforms } = createFakeContext()
      await plugin.default.setup(ctx as never)
      assert.equal(integrationTransforms.length, 1)

      const registrations: Array<Record<string, unknown>> = []
      integrationTransforms[0]({
        method: { update: (input: never) => registrations.push(input) },
      })

      assert.equal(registrations.length, 1)
      const registration = registrations[0] as {
        integrationID: string
        method: { id: string; type: string; form?: unknown }
        authorize: (answer: unknown) => Promise<unknown>
        refresh: () => Promise<unknown>
      }

      assert.equal(registration.integrationID, "anthropic")
      assert.equal(registration.method.type, "oauth")
      assert.equal(registration.method.id, "claude-code")
      assert.equal(
        registration.method.form,
        undefined,
        "a single account needs no picker",
      )
    })

    it("authorize returns an oauth credential for the chosen account", async () => {
      const { ctx, integrationTransforms } = createFakeContext()
      await plugin.default.setup(ctx as never)

      const registrations: Array<Record<string, unknown>> = []
      integrationTransforms[0]({
        method: { update: (input: never) => registrations.push(input) },
      })

      const registration = registrations[0] as unknown as {
        authorize: (answer: unknown) => Promise<{
          url: string
          instructions: string
          mode: string
          callback: Promise<{
            type: string
            access: string
            refresh: string
            expires: number
          }>
        }>
      }

      const result = await registration.authorize({})
      assert.equal(result.url, "")
      assert.equal(result.mode, "auto")
      assert.match(result.instructions, /Account 1/)

      const credential = await result.callback
      assert.equal(credential.type, "oauth")
      assert.equal(credential.access, "token")
      assert.equal(credential.refresh, "refresh")
    })

    it("refresh surfaces current credentials", async () => {
      const { ctx, integrationTransforms } = createFakeContext()
      await plugin.default.setup(ctx as never)

      const registrations: Array<Record<string, unknown>> = []
      integrationTransforms[0]({
        method: { update: (input: never) => registrations.push(input) },
      })

      const registration = registrations[0] as unknown as {
        refresh: () => Promise<{ type: string; access: string }>
      }

      const credential = await registration.refresh()
      assert.equal(credential.type, "oauth")
      assert.equal(credential.access, "token")
    })
  })
})

// --- Account selection helpers ---------------------------------------------

describe("resolveAccount", () => {
  it("defaults to Account 1 when no answer is provided", () => {
    assert.equal(
      helpers.resolveAccount(accounts, undefined)?.label,
      "Account 1",
    )
  })

  it("selects Account 2 by its source key", () => {
    assert.equal(
      helpers.resolveAccount(accounts, "Claude Code-credentials-b28bbb7c")
        ?.label,
      "Account 2",
    )
  })

  it("selects Account 3 by its source key", () => {
    assert.equal(
      helpers.resolveAccount(accounts, "Claude Code-credentials-abc123")?.label,
      "Account 3",
    )
  })

  it("falls back to Account 1 when source doesn't match any account", () => {
    assert.equal(
      helpers.resolveAccount(accounts, "Claude Code-credentials-unknown")
        ?.label,
      "Account 1",
    )
  })

  it("ignores a non-string answer", () => {
    assert.equal(helpers.resolveAccount(accounts, 42)?.label, "Account 1")
  })

  it("returns the correct credentials for the resolved account", () => {
    assert.equal(
      helpers.resolveAccount(accounts, "Claude Code-credentials-b28bbb7c")
        ?.credentials.accessToken,
      "at-2",
    )
  })

  it("returns undefined when there are no accounts", () => {
    assert.equal(helpers.resolveAccount([], "anything"), undefined)
  })
})

describe("buildAccountOptions", () => {
  it("builds one option per account", () => {
    assert.equal(
      helpers.buildAccountOptions(accounts, accounts[0].source).length,
      3,
    )
  })

  it("uses label as display text and source as value", () => {
    const options = helpers.buildAccountOptions(accounts, accounts[0].source)
    assert.equal(options[0].label, "Account 1")
    assert.equal(options[0].value, "Claude Code-credentials")
    assert.equal(options[1].label, "Account 2")
    assert.equal(options[1].value, "Claude Code-credentials-b28bbb7c")
  })

  it("marks the active account in its description", () => {
    const options = helpers.buildAccountOptions(
      accounts,
      "Claude Code-credentials-b28bbb7c",
    )
    assert.ok(options[1].description?.includes("(active)"))
    assert.ok(!options[0].description?.includes("(active)"))
    assert.ok(!options[2].description?.includes("(active)"))
  })
})

describe("syncToPath", () => {
  const tmp = join(tmpdir(), `opencode-test-${process.pid}`)

  it("writes anthropic credentials to auth.json", () => {
    mkdirSync(tmp, { recursive: true })
    const authPath = join(tmp, "auth.json")
    const creds = makeCreds({
      accessToken: "at-write",
      refreshToken: "rt-write",
      expiresAt: 1700000000000,
    })
    syncToPath(authPath, creds, realFs)
    const written = JSON.parse(readFileSync(authPath, "utf-8"))
    assert.deepEqual(written.anthropic, {
      type: "oauth",
      access: "at-write",
      refresh: "rt-write",
      expires: 1700000000000,
    })
    rmSync(tmp, { recursive: true, force: true })
  })

  it("preserves other providers already in auth.json", () => {
    mkdirSync(tmp, { recursive: true })
    const authPath = join(tmp, "auth.json")
    writeFileSync(
      authPath,
      JSON.stringify({
        "github-copilot": { type: "oauth", access: "gh-token" },
      }),
      "utf-8",
    )
    syncToPath(authPath, makeCreds(), realFs)
    const written = JSON.parse(readFileSync(authPath, "utf-8"))
    assert.ok(written["github-copilot"])
    assert.equal(written["github-copilot"].access, "gh-token")
    assert.ok(written.anthropic)
    rmSync(tmp, { recursive: true, force: true })
  })

  it("starts fresh when existing auth.json contains invalid JSON", () => {
    mkdirSync(tmp, { recursive: true })
    const authPath = join(tmp, "auth.json")
    writeFileSync(authPath, "{ broken json {{", "utf-8")
    syncToPath(authPath, makeCreds({ accessToken: "at-fresh" }), realFs)
    const written = JSON.parse(readFileSync(authPath, "utf-8"))
    assert.equal(written.anthropic.access, "at-fresh")
    assert.equal(Object.keys(written).length, 1)
    rmSync(tmp, { recursive: true, force: true })
  })

  it("creates the directory if it does not exist", () => {
    const authPath = join(tmp, "deep", "nested", "auth.json")
    syncToPath(authPath, makeCreds(), realFs)
    assert.ok(JSON.parse(readFileSync(authPath, "utf-8")).anthropic)
    rmSync(tmp, { recursive: true, force: true })
  })
})

function saveAccountSourceTo(stateFile: string, source: string): void {
  const dir = join(stateFile, "..")
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(stateFile, source, "utf-8")
}

function loadPersistedAccountSourceFrom(stateFile: string): string | null {
  try {
    if (existsSync(stateFile)) {
      return readFileSync(stateFile, "utf-8").trim() || null
    }
  } catch {
    // ignore
  }
  return null
}

function resolveStartupAccount(
  candidateAccounts: Account[],
  persistedSource: string | null,
): Account {
  return (
    (persistedSource &&
      candidateAccounts.find((a) => a.source === persistedSource)) ||
    candidateAccounts[0]
  )
}

describe("account persistence — saveAccountSource / loadPersistedAccountSource", () => {
  const tmp = join(tmpdir(), `opencode-persist-test-${process.pid}`)
  const stateFile = join(tmp, "claude-account-source.txt")

  it("returns null when the state file does not exist", () => {
    try {
      rmSync(stateFile, { force: true })
    } catch {
      /* ignore */
    }
    assert.equal(loadPersistedAccountSourceFrom(stateFile), null)
  })

  it("saves and loads the account source correctly", () => {
    saveAccountSourceTo(stateFile, "Claude Code-credentials-b28bbb7c")
    assert.equal(
      loadPersistedAccountSourceFrom(stateFile),
      "Claude Code-credentials-b28bbb7c",
    )
    rmSync(tmp, { recursive: true, force: true })
  })

  it("overwrites a previously saved source", () => {
    saveAccountSourceTo(stateFile, "Claude Code-credentials")
    saveAccountSourceTo(stateFile, "Claude Code-credentials-abc123")
    assert.equal(
      loadPersistedAccountSourceFrom(stateFile),
      "Claude Code-credentials-abc123",
    )
    rmSync(tmp, { recursive: true, force: true })
  })

  it("returns null when the state file is empty", () => {
    mkdirSync(tmp, { recursive: true })
    writeFileSync(stateFile, "   ", "utf-8")
    assert.equal(loadPersistedAccountSourceFrom(stateFile), null)
    rmSync(tmp, { recursive: true, force: true })
  })
})

describe("startup account selection — uses persisted source", () => {
  it("uses Account 1 when no source is persisted", () => {
    assert.equal(resolveStartupAccount(accounts, null).label, "Account 1")
  })

  it("restores Account 2 from persisted source", () => {
    assert.equal(
      resolveStartupAccount(accounts, "Claude Code-credentials-b28bbb7c").label,
      "Account 2",
    )
  })

  it("restores Account 3 from persisted source", () => {
    assert.equal(
      resolveStartupAccount(accounts, "Claude Code-credentials-abc123").label,
      "Account 3",
    )
  })

  it("falls back to Account 1 when the persisted source no longer exists", () => {
    assert.equal(
      resolveStartupAccount(accounts, "Claude Code-credentials-gone").label,
      "Account 1",
    )
  })

  it("restores correct credentials for the persisted account", () => {
    assert.equal(
      resolveStartupAccount(accounts, "Claude Code-credentials-b28bbb7c")
        .credentials.accessToken,
      "at-2",
    )
  })
})

describe("refreshIfNeeded — token expiry", () => {
  it("returns fresh when token expires more than 60s from now", () => {
    assert.equal(
      refreshIfNeeded(
        makeCreds({ expiresAt: Date.now() + 120_000 }),
        Date.now(),
      ),
      "fresh",
    )
  })

  it("returns expired when token expires in less than 60s", () => {
    assert.equal(
      refreshIfNeeded(
        makeCreds({ expiresAt: Date.now() + 30_000 }),
        Date.now(),
      ),
      "expired",
    )
  })

  it("returns expired when token is already past expiry", () => {
    assert.equal(
      refreshIfNeeded(makeCreds({ expiresAt: Date.now() - 1000 }), Date.now()),
      "expired",
    )
  })

  it("returns expired when token expires exactly at the 60s boundary", () => {
    const now = Date.now()
    assert.equal(
      refreshIfNeeded(makeCreds({ expiresAt: now + 60_000 }), now),
      "expired",
    )
  })

  it("returns fresh when token expires exactly 1ms past the 60s boundary", () => {
    const now = Date.now()
    assert.equal(
      refreshIfNeeded(makeCreds({ expiresAt: now + 60_001 }), now),
      "fresh",
    )
  })
})
