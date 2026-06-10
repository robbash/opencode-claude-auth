import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import {
  buildAccountLabels,
  credentialBlobMatches,
  deriveKeychainDescription,
  keychainSuffixForDir,
  parseCredentials,
  parseKeychainDump,
  readAllClaudeAccounts as readAllClaudeAccountsReal,
  readCredentialsFile,
  updateCredentialBlob,
  writeBackCredentials,
} from "./keychain.ts"

type MockedKeychain = {
  readAllClaudeAccounts: () => Array<{
    label: string
    source: string
    configDir?: string
    description?: string
    credentials: {
      accessToken: string
      refreshToken: string
      expiresAt: number
      subscriptionType?: string
    }
  }>
  writeBackCredentials: (
    source: string,
    creds: { accessToken: string; refreshToken: string; expiresAt: number },
    configDir?: string,
    expectedPriorAccessToken?: string,
  ) => boolean
  __getSecurityWrites: () => Array<{ service: string; value: string }>
}

async function loadKeychainWithMockedSecurity(
  securityDump: string,
  keychainEntries: Record<string, string>,
): Promise<MockedKeychain> {
  const tempDir = await mkdtemp(
    join(tmpdir(), "opencode-claude-auth-keychain-"),
  )
  const tempKeychain = join(tempDir, "keychain.ts")
  const tempLogger = join(tempDir, "logger.ts")
  const tempChildProcess = join(tempDir, "child-process.ts")
  const sourceKeychain = await readFile(
    new URL("./keychain.ts", import.meta.url),
    "utf8",
  )
  const rewritten = sourceKeychain
    .replace(/from\s+["']\.\/(\w+)\.js["']/g, 'from "./$1.ts"')
    .replace(/from\s+["']node:child_process["']/, 'from "./child-process.ts"')
    .replace(/process\.platform/g, '"darwin"')

  await writeFile(
    tempLogger,
    `export function log() {}\nexport function initLogger() {}\nexport function closeLogger() {}\n`,
    "utf8",
  )

  await writeFile(
    tempChildProcess,
    `const securityDump = ${JSON.stringify(securityDump)}
const keychainEntries = ${JSON.stringify(keychainEntries)}

export function execSync(command) {
  if (command.includes("dump-keychain")) return securityDump
  if (command.includes("find-generic-password")) {
    const match = command.match(/-s "([^"]+)"/)
    const service = match ? match[1] : undefined
    const raw = service ? keychainEntries[service] : undefined
    if (raw === undefined) {
      const error = new Error("The specified item could not be found in the keychain.")
      error.status = 44
      throw error
    }
    return raw
  }
  throw new Error("unexpected execSync call: " + command)
}

const securityWrites = []

export function execFileSync(file, args) {
  if (file !== "/usr/bin/security") {
    throw new Error("unexpected execFileSync file: " + file)
  }
  const service = args[args.indexOf("-s") + 1]

  // add-generic-password is the write path. Record it and mutate the backing
  // store, so a test can tell "the write was skipped" from "the write ran".
  if (args[0] === "add-generic-password") {
    const value = args[args.indexOf("-w") + 1]
    securityWrites.push({ service, value })
    keychainEntries[service] = value
    return ""
  }

  const raw = keychainEntries[service]
  if (raw === undefined) {
    const error = new Error("The specified item could not be found in the keychain.")
    error.status = 44
    error.stderr = "The specified item could not be found in the keychain."
    throw error
  }
  return raw
}

export function __getSecurityWrites() {
  return securityWrites
}
`,
    "utf8",
  )

  await writeFile(tempKeychain, rewritten, "utf8")
  const [keychainModule, childProcessModule] = await Promise.all([
    import(pathToFileURL(tempKeychain).href),
    import(pathToFileURL(tempChildProcess).href),
  ])
  return {
    ...keychainModule,
    __getSecurityWrites: childProcessModule.__getSecurityWrites,
  } as MockedKeychain
}

/**
 * Build a fixture in the shape `security dump-keychain` actually emits, so
 * tests exercise the real attribute parser instead of a stand-in.
 */
function proBlob(accessToken: string): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken,
      refreshToken: `rt-${accessToken}`,
      expiresAt: 1_700_000_000_000,
      subscriptionType: "pro",
    },
  })
}

function dumpAttr(name: string, value: string | undefined): string {
  return `    "${name}"<blob>=${value === undefined ? "<NULL>" : `"${value}"`}\n`
}

function genpDump(
  items: Array<{
    service: string | null
    label?: string
    comment?: string
    description?: string
    account?: string
    class?: string
  }>,
): string {
  return items
    .map((item) => {
      const label =
        item.label === undefined
          ? item.service === null
            ? "<NULL>"
            : `"${item.service}"`
          : `"${item.label}"`
      return (
        `keychain: "/Users/test/Library/Keychains/login.keychain-db"\n` +
        `version: 512\n` +
        `class: "${item.class ?? "genp"}"\n` +
        `attributes:\n` +
        `    0x00000007 <blob>=${label}\n` +
        dumpAttr("acct", item.account ?? "testuser") +
        dumpAttr("desc", item.description) +
        dumpAttr("icmt", item.comment) +
        dumpAttr("svce", item.service ?? undefined)
      )
    })
    .join("")
}

/**
 * The service list `listClaudeKeychainEntries` would produce for a dump.
 *
 * Mirrors only the filter and ordering (that function needs `execSync`); the
 * parsing underneath is the real implementation.
 */
function extractServicesFromDump(output: string): string[] {
  const PRIMARY = "Claude Code-credentials"
  const re = /^Claude Code-credentials(?:-[0-9a-f]+)?$/

  const seen = new Set<string>()
  for (const entry of parseKeychainDump(output)) {
    if (re.test(entry.service)) seen.add(entry.service)
  }

  const ordered: string[] = []
  if (seen.has(PRIMARY)) ordered.push(PRIMARY)
  for (const svc of seen) {
    if (svc !== PRIMARY) ordered.push(svc)
  }
  return ordered
}

describe("parseCredentials", () => {
  it("parses credentials with claudeAiOauth wrapper", () => {
    const raw = JSON.stringify({
      claudeAiOauth: {
        accessToken: "at-123",
        refreshToken: "rt-456",
        expiresAt: 1700000000000,
        subscriptionType: "pro",
      },
    })
    const result = parseCredentials(raw)
    assert.ok(result)
    assert.equal(result.accessToken, "at-123")
    assert.equal(result.refreshToken, "rt-456")
    assert.equal(result.expiresAt, 1700000000000)
    assert.equal(result.subscriptionType, "pro")
  })

  it("parses credentials at root level", () => {
    const raw = JSON.stringify({
      accessToken: "at-789",
      refreshToken: "rt-012",
      expiresAt: 1700000000000,
    })
    const result = parseCredentials(raw)
    assert.ok(result)
    assert.equal(result.accessToken, "at-789")
    assert.equal(result.refreshToken, "rt-012")
    assert.equal(result.expiresAt, 1700000000000)
  })

  it("truncates a fractional stored expiresAt", () => {
    const raw = JSON.stringify({
      claudeAiOauth: {
        accessToken: "at-123",
        refreshToken: "rt-456",
        expiresAt: 1784891051785.9011,
      },
    })

    const result = parseCredentials(raw)

    assert.ok(result)
    assert.equal(result.expiresAt, 1784891051785)
    assert.equal(Number.isInteger(result.expiresAt), true)
  })

  it("subscriptionType is undefined when not present", () => {
    const raw = JSON.stringify({
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: 1700000000000,
    })
    const result = parseCredentials(raw)
    assert.ok(result)
    assert.equal(result.subscriptionType, undefined)
  })

  it("returns null for MCP-only entries", () => {
    const raw = JSON.stringify({
      mcpOAuth: { "neon|abc123": { serverName: "neon" } },
    })
    assert.equal(parseCredentials(raw), null)
  })

  it("returns null for invalid JSON", () => {
    assert.equal(parseCredentials("not json {{{"), null)
  })
})

describe("keychain service discovery", () => {
  it("discovers primary and suffixed services, primary first", () => {
    assert.deepEqual(
      extractServicesFromDump(
        genpDump([
          { service: "Claude Code-credentials-b28bbb7c" },
          { service: "Claude Code-credentials" },
        ]),
      ),
      ["Claude Code-credentials", "Claude Code-credentials-b28bbb7c"],
    )
  })

  it("does not match uppercase or arbitrary suffixes", () => {
    assert.deepEqual(
      extractServicesFromDump(
        genpDump([
          { service: "Claude Code-credentials-B28BBB7C" },
          { service: "Claude Code-credentials-myaccount" },
        ]),
      ),
      [],
    )
  })

  it("discovers legacy hex suffixes that are not exactly 8 chars", () => {
    assert.deepEqual(
      extractServicesFromDump(
        genpDump([
          { service: "Claude Code-credentials-abc" },
          { service: "Claude Code-credentials-deadbeefcafebabe" },
        ]),
      ),
      [
        "Claude Code-credentials-abc",
        "Claude Code-credentials-deadbeefcafebabe",
      ],
    )
  })

  it("ignores non-Claude keychain items", () => {
    assert.deepEqual(
      extractServicesFromDump(
        genpDump([
          { service: "com.example.Example", label: "Example" },
          { service: "Claude Code-credentials" },
        ]),
      ),
      ["Claude Code-credentials"],
    )
  })

  it("deduplicates repeated services", () => {
    assert.deepEqual(
      extractServicesFromDump(
        genpDump([
          { service: "Claude Code-credentials-b28bbb7c" },
          { service: "Claude Code-credentials-b28bbb7c" },
        ]),
      ),
      ["Claude Code-credentials-b28bbb7c"],
    )
  })

  it("finds entries whose human label was renamed away from the service", () => {
    // The 0x00000007 label is user-editable in Keychain Access; discovery must
    // key off `svce`, which the CLI owns.
    assert.deepEqual(
      extractServicesFromDump(
        genpDump([
          {
            service: "Claude Code-credentials-12345678",
            label: "Jack's work account",
          },
        ]),
      ),
      ["Claude Code-credentials-12345678"],
    )
  })

  it("returns nothing for a dump with no Claude entries", () => {
    assert.deepEqual(extractServicesFromDump(""), [])
    assert.deepEqual(
      extractServicesFromDump(
        genpDump([{ service: "Claude Code-credentials", class: "inet" }]),
      ),
      [],
    )
  })
})

const makeAccountCreds = (
  sub?: string,
): {
  accessToken: string
  refreshToken: string
  expiresAt: number
  subscriptionType?: string
} => ({
  accessToken: "at",
  refreshToken: "rt",
  expiresAt: 9999999999999,
  subscriptionType: sub,
})

describe("account labelling", () => {
  it("uses subscription type and deduplicates tiers", () => {
    assert.deepEqual(
      buildAccountLabels([
        makeAccountCreds("pro"),
        makeAccountCreds("pro"),
        makeAccountCreds("max"),
      ]),
      ["Claude Pro 1", "Claude Pro 2", "Claude Max"],
    )
  })

  it("falls back to Claude when no subscription type", () => {
    assert.equal(buildAccountLabels([makeAccountCreds()])[0], "Claude")
  })

  it("appends email when provided", () => {
    assert.deepEqual(
      buildAccountLabels(
        [makeAccountCreds("pro"), makeAccountCreds("pro")],
        ["a@example.com", "b@example.com"],
      ),
      ["Claude Pro 1: a@example.com", "Claude Pro 2: b@example.com"],
    )
  })

  it("skips email when absent", () => {
    assert.deepEqual(
      buildAccountLabels(
        [makeAccountCreds("pro"), makeAccountCreds("team")],
        [null, "bob@example.com"],
        ["Claude Code-credentials", "Claude Code-credentials-b28bbb7c"],
      ),
      ["Claude Pro: Claude Code-credentials", "Claude Team: bob@example.com"],
    )
  })
})

describe("readAllClaudeAccounts", () => {
  it("resolves suffixed keychain services back to config dirs and emails", async () => {
    const originalHome = process.env.HOME
    const tempHome = await mkdtemp(join(tmpdir(), "opencode-claude-auth-home-"))
    const primaryDir = join(tempHome, ".claude")
    const workDir = join(tempHome, ".work")
    const workSuffix = keychainSuffixForDir(workDir)

    mkdirSync(primaryDir, { recursive: true })
    mkdirSync(workDir, { recursive: true })

    writeFileSync(
      join(primaryDir, ".claude.json"),
      JSON.stringify({
        oauthAccount: { emailAddress: "primary@example.com" },
      }),
    )
    writeFileSync(
      join(workDir, ".claude.json"),
      JSON.stringify({
        oauthAccount: { emailAddress: "work@example.com" },
      }),
    )

    const dump = genpDump([
      { service: `Claude Code-credentials-${workSuffix}` },
      { service: "Claude Code-credentials" },
    ])
    const primaryCreds = JSON.stringify({
      claudeAiOauth: {
        accessToken: "primary-at",
        refreshToken: "primary-rt",
        expiresAt: 1_700_000_000_000,
        subscriptionType: "pro",
      },
    })
    const workCreds = JSON.stringify({
      claudeAiOauth: {
        accessToken: "work-at",
        refreshToken: "work-rt",
        expiresAt: 1_700_000_000_001,
        subscriptionType: "pro",
      },
    })

    process.env.HOME = tempHome

    try {
      const { readAllClaudeAccounts } = await loadKeychainWithMockedSecurity(
        dump,
        {
          "Claude Code-credentials": primaryCreds,
          [`Claude Code-credentials-${workSuffix}`]: workCreds,
        },
      )

      assert.deepEqual(readAllClaudeAccounts(), [
        {
          label: "Claude Pro 1: primary@example.com",
          source: "Claude Code-credentials",
          configDir: primaryDir,
          credentials: {
            accessToken: "primary-at",
            refreshToken: "primary-rt",
            expiresAt: 1_700_000_000_000,
            subscriptionType: "pro",
          },
        },
        {
          label: "Claude Pro 2: work@example.com",
          source: `Claude Code-credentials-${workSuffix}`,
          configDir: workDir,
          credentials: {
            accessToken: "work-at",
            refreshToken: "work-rt",
            expiresAt: 1_700_000_000_001,
            subscriptionType: "pro",
          },
        },
      ])
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = originalHome
      }
      rmSync(tempHome, { recursive: true, force: true })
    }
  })

  it("keeps keychain source visible when email lookup fails", async () => {
    const originalHome = process.env.HOME
    const tempHome = await mkdtemp(join(tmpdir(), "opencode-claude-auth-home-"))
    const primaryDir = join(tempHome, ".claude")
    const workDir = join(tempHome, ".work")
    const workSuffix = keychainSuffixForDir(workDir)

    mkdirSync(primaryDir, { recursive: true })
    mkdirSync(workDir, { recursive: true })
    writeFileSync(join(primaryDir, ".claude.json"), JSON.stringify({}))
    writeFileSync(join(workDir, ".claude.json"), JSON.stringify({}))

    process.env.HOME = tempHome

    try {
      const { readAllClaudeAccounts } = await loadKeychainWithMockedSecurity(
        genpDump([{ service: `Claude Code-credentials-${workSuffix}` }]),
        {
          [`Claude Code-credentials-${workSuffix}`]: JSON.stringify({
            claudeAiOauth: {
              accessToken: "work-at",
              refreshToken: "work-rt",
              expiresAt: 1_700_000_000_001,
            },
          }),
        },
      )

      const [account] = readAllClaudeAccounts()
      assert.equal(account.source, `Claude Code-credentials-${workSuffix}`)
      assert.equal(
        account.label,
        `Claude: Claude Code-credentials-${workSuffix}`,
      )
      assert.equal(account.configDir, workDir)
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = originalHome
      }
      rmSync(tempHome, { recursive: true, force: true })
    }
  })

  it("keeps legacy hex suffixes that are not exactly 8 chars discoverable", async () => {
    const originalHome = process.env.HOME
    const tempHome = await mkdtemp(join(tmpdir(), "opencode-claude-auth-home-"))
    const primaryDir = join(tempHome, ".claude")
    mkdirSync(primaryDir, { recursive: true })
    writeFileSync(join(primaryDir, ".claude.json"), JSON.stringify({}))

    process.env.HOME = tempHome

    try {
      const { readAllClaudeAccounts } = await loadKeychainWithMockedSecurity(
        genpDump([{ service: "Claude Code-credentials-abc" }]),
        {
          "Claude Code-credentials-abc": JSON.stringify({
            claudeAiOauth: {
              accessToken: "legacy-at",
              refreshToken: "legacy-rt",
              expiresAt: 1_700_000_000_000,
            },
          }),
        },
      )

      const accounts = readAllClaudeAccounts()
      assert.equal(accounts.length, 1)
      assert.equal(accounts[0].source, "Claude Code-credentials-abc")
      // A non-8-char suffix cannot be mapped back to a config dir hash, so
      // the entry falls back to the primary config dir — matching the CLI
      // refresh behaviour these legacy entries had before suffix mapping
      // existed.
      assert.equal(accounts[0].configDir, primaryDir)
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = originalHome
      }
      rmSync(tempHome, { recursive: true, force: true })
    }
  })

  it("labels accounts with the user-set Keychain comment", async () => {
    const originalHome = process.env.HOME
    const tempHome = await mkdtemp(join(tmpdir(), "opencode-claude-auth-home-"))
    const primaryDir = join(tempHome, ".claude")
    const workDir = join(tempHome, ".work")
    const workSuffix = keychainSuffixForDir(workDir)

    mkdirSync(primaryDir, { recursive: true })
    mkdirSync(workDir, { recursive: true })
    writeFileSync(
      join(primaryDir, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "primary@example.com" } }),
    )
    writeFileSync(
      join(workDir, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "work@example.com" } }),
    )

    process.env.HOME = tempHome

    try {
      const { readAllClaudeAccounts } = await loadKeychainWithMockedSecurity(
        genpDump([
          { service: "Claude Code-credentials" },
          {
            service: `Claude Code-credentials-${workSuffix}`,
            comment: "Work sub",
          },
        ]),
        {
          "Claude Code-credentials": proBlob("primary-at"),
          [`Claude Code-credentials-${workSuffix}`]: proBlob("work-at"),
        },
      )

      const accounts = readAllClaudeAccounts()
      // The commented entry drops the number and the email in favour of the
      // name the user chose; the uncommented one keeps the generated label.
      assert.equal(accounts[0].label, "Claude Pro 1: primary@example.com")
      assert.equal(accounts[0].description, undefined)
      assert.equal(accounts[1].label, "Claude Pro - Work sub")
      assert.equal(accounts[1].description, "Work sub")
      // Descriptions must not disturb config-dir resolution.
      assert.equal(accounts[1].configDir, workDir)
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = originalHome
      }
      rmSync(tempHome, { recursive: true, force: true })
    }
  })
})

describe("credentials file fallback", () => {
  const tmpDir = join(tmpdir(), `claude-test-${process.pid}`)

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("reads valid credentials from a config dir", () => {
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(
      join(tmpDir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "file-at",
          refreshToken: "file-rt",
          expiresAt: 1700000000000,
        },
      }),
    )

    assert.deepEqual(readCredentialsFile(tmpDir), {
      accessToken: "file-at",
      refreshToken: "file-rt",
      expiresAt: 1700000000000,
      subscriptionType: undefined,
    })
  })

  it("returns null when the file does not exist", () => {
    assert.equal(readCredentialsFile(join(tmpDir, "missing")), null)
  })

  it("returns null when the file contains invalid JSON", () => {
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(join(tmpDir, ".credentials.json"), "{ broken json")
    assert.equal(readCredentialsFile(tmpDir), null)
  })
})

describe("updateCredentialBlob", () => {
  it("updates tokens in claudeAiOauth wrapper format", () => {
    const existing = JSON.stringify({
      claudeAiOauth: {
        accessToken: "old-at",
        refreshToken: "old-rt",
        expiresAt: 1000,
        subscriptionType: "pro",
      },
    })
    const newCreds = {
      accessToken: "new-at",
      refreshToken: "new-rt",
      expiresAt: 2000,
    }
    const result = JSON.parse(updateCredentialBlob(existing, newCreds)!)
    assert.equal(result.claudeAiOauth.accessToken, "new-at")
    assert.equal(result.claudeAiOauth.subscriptionType, "pro")
  })

  it("updates tokens in root-level format", () => {
    const existing = JSON.stringify({
      accessToken: "old-at",
      refreshToken: "old-rt",
      expiresAt: 1000,
    })
    const newCreds = {
      accessToken: "new-at",
      refreshToken: "new-rt",
      expiresAt: 2000,
    }
    const result = JSON.parse(updateCredentialBlob(existing, newCreds)!)
    assert.equal(result.accessToken, "new-at")
    assert.equal(result.refreshToken, "new-rt")
    assert.equal(result.expiresAt, 2000)
  })

  it("preserves mcpOAuth and other unrelated fields", () => {
    const existing = JSON.stringify({
      claudeAiOauth: {
        accessToken: "old-at",
        refreshToken: "old-rt",
        expiresAt: 1000,
      },
      mcpOAuth: { "neon|abc": { serverName: "neon" } },
    })
    const newCreds = {
      accessToken: "new-at",
      refreshToken: "new-rt",
      expiresAt: 2000,
    }
    const result = JSON.parse(updateCredentialBlob(existing, newCreds)!)
    assert.ok(result.mcpOAuth)
    assert.equal(result.mcpOAuth["neon|abc"].serverName, "neon")
  })

  it("returns null for invalid JSON input", () => {
    assert.equal(
      updateCredentialBlob("not json", {
        accessToken: "a",
        refreshToken: "r",
        expiresAt: 1,
      }),
      null,
    )
  })
})

describe("credentialBlobMatches", () => {
  const blob = JSON.stringify({
    claudeAiOauth: {
      accessToken: "account-a",
      refreshToken: "rt-a",
      expiresAt: 1,
    },
  })

  it("accepts a blob still holding the expected token", () => {
    assert.equal(credentialBlobMatches(blob, "account-a"), true)
  })

  it("rejects a blob replaced by another account", () => {
    assert.equal(credentialBlobMatches(blob, "account-b"), false)
  })

  it("rejects an unparseable blob rather than assuming a match", () => {
    assert.equal(credentialBlobMatches("not json", "account-a"), false)
  })

  // The guard validates through parseCredentials; the write it protects uses
  // updateCredentialBlob, which would rewrite this blob happily. Pinning the
  // stricter side so the divergence is a decision rather than an accident.
  it("rejects a blob whose token matches but whose other fields are malformed", () => {
    const malformed = JSON.stringify({
      claudeAiOauth: {
        accessToken: "account-a",
        refreshToken: 12345,
        expiresAt: "soon",
      },
    })
    assert.equal(credentialBlobMatches(malformed, "account-a"), false)
  })
})

describe("parseKeychainDump", () => {
  // Mirrors the real format emitted by `security dump-keychain` on macOS.
  // Includes: a primary Claude entry, a renamed/comment-tagged entry whose
  // 0x00000007 label and `svce` differ, a non-Claude item that must be
  // ignored, and a mix of <NULL> attributes.
  const KEYCHAIN_DUMP = `keychain: "/Users/test/Library/Keychains/login.keychain-db"
version: 512
class: "genp"
attributes:
    0x00000007 <blob>="Claude Code-credentials"
    0x00000008 <blob>=<NULL>
    "acct"<blob>="testuser"
    "cdat"<timedate>=0x32303230303130313030303030305A00  "20200101000000Z\\000"
    "crtr"<uint32>=<NULL>
    "desc"<blob>=<NULL>
    "icmt"<blob>=<NULL>
    "mdat"<timedate>=0x32303230303130313030303030305A00  "20200101000000Z\\000"
    "svce"<blob>="Claude Code-credentials"
    "type"<uint32>=<NULL>
keychain: "/Users/test/Library/Keychains/login.keychain-db"
version: 512
class: "genp"
attributes:
    0x00000007 <blob>="Claude Code-credentials-12345678"
    0x00000008 <blob>=<NULL>
    "acct"<blob>="testuser"
    "cdat"<timedate>=0x32303230303130313030303030305A00  "20200101000000Z\\000"
    "desc"<blob>=<NULL>
    "icmt"<blob>="Jack Test"
    "svce"<blob>="Claude Code-credentials-12345678"
    "type"<uint32>=<NULL>
keychain: "/Users/test/Library/Keychains/login.keychain-db"
version: 512
class: "genp"
attributes:
    0x00000007 <blob>="Example"
    "acct"<blob>="some-db"
    "desc"<blob>="application password"
    "icmt"<blob>=<NULL>
    "svce"<blob>="com.example.Example"
keychain: "/Users/test/Library/Keychains/login.keychain-db"
version: 512
class: "genp"
attributes:
    0x00000007 <blob>="Claude Code-credentials-23456789"
    "acct"<blob>="testuser"
    "desc"<blob>=<NULL>
    "icmt"<blob>=<NULL>
    "svce"<blob>="Claude Code-credentials-23456789"
    "type"<uint32>=<NULL>
`

  it("parses every genp item in the dump", () => {
    assert.equal(parseKeychainDump(KEYCHAIN_DUMP).length, 4)
  })

  it("extracts the svce attribute as service", () => {
    assert.deepEqual(
      parseKeychainDump(KEYCHAIN_DUMP).map((e) => e.service),
      [
        "Claude Code-credentials",
        "Claude Code-credentials-12345678",
        "com.example.Example",
        "Claude Code-credentials-23456789",
      ],
    )
  })

  it("extracts the 0x00000007 attribute as label", () => {
    const entries = parseKeychainDump(KEYCHAIN_DUMP)
    assert.equal(entries[0].label, "Claude Code-credentials")
    assert.equal(entries[1].label, "Claude Code-credentials-12345678")
    assert.equal(entries[2].label, "Example")
  })

  it("extracts the icmt attribute as comment", () => {
    assert.equal(parseKeychainDump(KEYCHAIN_DUMP)[1].comment, "Jack Test")
  })

  it("extracts the acct attribute as account", () => {
    const entries = parseKeychainDump(KEYCHAIN_DUMP)
    assert.equal(entries[0].account, "testuser")
    assert.equal(entries[2].account, "some-db")
  })

  it("converts <NULL> attribute values to undefined", () => {
    const entries = parseKeychainDump(KEYCHAIN_DUMP)
    assert.equal(entries[0].comment, undefined)
    assert.equal(entries[0].description, undefined)
    assert.equal(entries[3].comment, undefined)
  })

  it("extracts a non-null desc attribute", () => {
    assert.equal(
      parseKeychainDump(KEYCHAIN_DUMP)[2].description,
      "application password",
    )
  })

  it("keeps each item's annotations attached to its own service", () => {
    // The whole point of attribute parsing: "Jack Test" belongs to 12345678
    // and must not leak onto its neighbours.
    const byService = new Map(
      parseKeychainDump(KEYCHAIN_DUMP).map((e) => [e.service, e]),
    )
    assert.equal(
      byService.get("Claude Code-credentials-12345678")?.comment,
      "Jack Test",
    )
    assert.equal(
      byService.get("Claude Code-credentials-23456789")?.comment,
      undefined,
    )
  })

  it("skips items that have no svce attribute", () => {
    const dump = `class: "genp"
attributes:
    "acct"<blob>="orphan"
    "svce"<blob>=<NULL>
class: "genp"
attributes:
    "acct"<blob>="ok"
    "svce"<blob>="real"
`
    const entries = parseKeychainDump(dump)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].service, "real")
  })

  it("returns an empty array for an empty dump", () => {
    assert.deepEqual(parseKeychainDump(""), [])
  })

  it("returns an empty array when no genp items are present", () => {
    assert.deepEqual(
      parseKeychainDump(`keychain: "x"\nversion: 512\nclass: "inet"\n`),
      [],
    )
  })
})

describe("deriveKeychainDescription", () => {
  it("returns the comment when present", () => {
    assert.equal(
      deriveKeychainDescription({
        service: "Claude Code-credentials-12345678",
        comment: "Claude Sub 12345678",
      }),
      "Claude Sub 12345678",
    )
  })

  it("trims surrounding whitespace from the comment", () => {
    assert.equal(
      deriveKeychainDescription({
        service: "svc",
        comment: "   spaced description   ",
      }),
      "spaced description",
    )
  })

  it("returns undefined for an empty or whitespace-only comment", () => {
    assert.equal(
      deriveKeychainDescription({ service: "svc", comment: "" }),
      undefined,
    )
    assert.equal(
      deriveKeychainDescription({ service: "svc", comment: "   " }),
      undefined,
    )
  })

  it("returns undefined when comment is absent, ignoring label and desc", () => {
    // We deliberately do NOT fall back to label or desc — `desc` is written by
    // macOS ("application password") and the label mirrors the service, so the
    // icmt field is the only user-meaningful annotation.
    assert.equal(
      deriveKeychainDescription({
        service: "Claude Code-credentials-12345678",
        label: "Claude Code-credentials-12345678",
        description: "application password",
      }),
      undefined,
    )
  })

  it("returns undefined for a fully empty entry", () => {
    assert.equal(deriveKeychainDescription({ service: "svc" }), undefined)
  })
})

describe("writeBackCredentials (file source)", () => {
  // These tests isolate via HOME; unset CLAUDE_CONFIG_DIR so an ambient value
  // (e.g. in CI or a dev shell) doesn't redirect the credentials path.
  let savedConfigDir: string | undefined
  beforeEach(() => {
    savedConfigDir = process.env.CLAUDE_CONFIG_DIR
    delete process.env.CLAUDE_CONFIG_DIR
  })
  afterEach(() => {
    if (typeof savedConfigDir === "string")
      process.env.CLAUDE_CONFIG_DIR = savedConfigDir
    else delete process.env.CLAUDE_CONFIG_DIR
  })

  it("reads, updates, and writes back credentials to file", async () => {
    const originalHome = process.env.HOME
    const tempHome = await mkdtemp(join(tmpdir(), "opencode-claude-auth-wb-"))
    process.env.HOME = tempHome

    try {
      const claudeDir = join(tempHome, ".claude")
      mkdirSync(claudeDir, { recursive: true })
      const credPath = join(claudeDir, ".credentials.json")
      writeFileSync(
        credPath,
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "old-at",
            refreshToken: "old-rt",
            expiresAt: 1000,
            subscriptionType: "pro",
          },
        }),
        { encoding: "utf-8", mode: 0o600 },
      )

      const result = writeBackCredentials("file", {
        accessToken: "new-at",
        refreshToken: "new-rt",
        expiresAt: 2000,
      })

      assert.equal(result, true)
      const written = JSON.parse(readFileSync(credPath, "utf-8"))
      assert.equal(written.claudeAiOauth.accessToken, "new-at")
      assert.equal(written.claudeAiOauth.subscriptionType, "pro")
    } finally {
      if (typeof originalHome === "string") {
        process.env.HOME = originalHome
      } else {
        delete process.env.HOME
      }
      rmSync(tempHome, { recursive: true, force: true })
    }
  })

  it("writes when the stored token still matches the expected one", async () => {
    const originalHome = process.env.HOME
    const tempHome = await mkdtemp(join(tmpdir(), "opencode-claude-auth-cas-"))
    process.env.HOME = tempHome

    try {
      const claudeDir = join(tempHome, ".claude")
      mkdirSync(claudeDir, { recursive: true })
      const credPath = join(claudeDir, ".credentials.json")
      writeFileSync(
        credPath,
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "old-at",
            refreshToken: "old-rt",
            expiresAt: 1000,
            subscriptionType: "pro",
          },
        }),
        { encoding: "utf-8", mode: 0o600 },
      )

      const result = writeBackCredentials(
        "file",
        {
          accessToken: "new-at",
          refreshToken: "new-rt",
          expiresAt: 2000,
        },
        undefined,
        "old-at",
      )

      assert.equal(result, true, "a matching guard must not block the write")
      const written = JSON.parse(readFileSync(credPath, "utf-8"))
      assert.equal(written.claudeAiOauth.accessToken, "new-at")
      assert.equal(written.claudeAiOauth.subscriptionType, "pro")
    } finally {
      if (typeof originalHome === "string") {
        process.env.HOME = originalHome
      } else {
        delete process.env.HOME
      }
      rmSync(tempHome, { recursive: true, force: true })
    }
  })

  it("skips the write when the stored token is no longer the expected one", async () => {
    const originalHome = process.env.HOME
    const tempHome = await mkdtemp(join(tmpdir(), "opencode-claude-auth-cas-"))
    process.env.HOME = tempHome

    try {
      const claudeDir = join(tempHome, ".claude")
      mkdirSync(claudeDir, { recursive: true })
      const credPath = join(claudeDir, ".credentials.json")
      // Another process switched accounts after we read "expected-at".
      writeFileSync(
        credPath,
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "switched-in-at",
            refreshToken: "switched-in-rt",
            expiresAt: 1000,
          },
        }),
        { encoding: "utf-8", mode: 0o600 },
      )

      const result = writeBackCredentials(
        "file",
        {
          accessToken: "our-refreshed-at",
          refreshToken: "our-refreshed-rt",
          expiresAt: 2000,
        },
        undefined,
        "expected-at",
      )

      assert.equal(result, false)
      const written = JSON.parse(readFileSync(credPath, "utf-8"))
      assert.equal(
        written.claudeAiOauth.accessToken,
        "switched-in-at",
        "the switched-in credential must survive untouched",
      )
    } finally {
      if (typeof originalHome === "string") {
        process.env.HOME = originalHome
      } else {
        delete process.env.HOME
      }
      rmSync(tempHome, { recursive: true, force: true })
    }
  })

  it("writes file with 0o600 permissions", async () => {
    if (process.platform === "win32") return

    const originalHome = process.env.HOME
    const tempHome = await mkdtemp(
      join(tmpdir(), "opencode-claude-auth-wb-perms-"),
    )
    process.env.HOME = tempHome

    try {
      const claudeDir = join(tempHome, ".claude")
      mkdirSync(claudeDir, { recursive: true })
      const credPath = join(claudeDir, ".credentials.json")
      writeFileSync(
        credPath,
        JSON.stringify({ accessToken: "at", refreshToken: "rt", expiresAt: 1 }),
        { encoding: "utf-8", mode: 0o644 },
      )
      chmodSync(credPath, 0o644)

      writeBackCredentials("file", {
        accessToken: "new-at",
        refreshToken: "new-rt",
        expiresAt: 2000,
      })

      const mode = statSync(credPath).mode & 0o777
      assert.equal(mode, 0o600)
    } finally {
      if (typeof originalHome === "string") {
        process.env.HOME = originalHome
      } else {
        delete process.env.HOME
      }
      rmSync(tempHome, { recursive: true, force: true })
    }
  })

  it("returns false when credentials file does not exist", async () => {
    const originalHome = process.env.HOME
    const tempHome = await mkdtemp(
      join(tmpdir(), "opencode-claude-auth-wb-missing-"),
    )
    process.env.HOME = tempHome

    try {
      const result = writeBackCredentials("file", {
        accessToken: "at",
        refreshToken: "rt",
        expiresAt: 1000,
      })
      assert.equal(result, false)
    } finally {
      if (typeof originalHome === "string") {
        process.env.HOME = originalHome
      } else {
        delete process.env.HOME
      }
      rmSync(tempHome, { recursive: true, force: true })
    }
  })

  it("returns false when credentials file contains invalid JSON", async () => {
    const originalHome = process.env.HOME
    const tempHome = await mkdtemp(
      join(tmpdir(), "opencode-claude-auth-wb-invalid-"),
    )
    process.env.HOME = tempHome

    try {
      const claudeDir = join(tempHome, ".claude")
      mkdirSync(claudeDir, { recursive: true })
      writeFileSync(join(claudeDir, ".credentials.json"), "not json {")

      const result = writeBackCredentials("file", {
        accessToken: "at",
        refreshToken: "rt",
        expiresAt: 1000,
      })
      assert.equal(result, false)
    } finally {
      if (typeof originalHome === "string") {
        process.env.HOME = originalHome
      } else {
        delete process.env.HOME
      }
      rmSync(tempHome, { recursive: true, force: true })
    }
  })

  it("uses CLAUDE_CONFIG_DIR when set", async () => {
    const originalHome = process.env.HOME
    const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    const tempHome = await mkdtemp(
      join(tmpdir(), "opencode-claude-auth-wb-home-"),
    )
    const configDir = await mkdtemp(
      join(tmpdir(), "opencode-claude-auth-wb-cfg-"),
    )
    process.env.HOME = tempHome
    process.env.CLAUDE_CONFIG_DIR = configDir

    try {
      // Credentials live in CLAUDE_CONFIG_DIR, not ~/.claude
      const credPath = join(configDir, ".credentials.json")
      writeFileSync(
        credPath,
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "old-at",
            refreshToken: "old-rt",
            expiresAt: 1000,
          },
        }),
        { encoding: "utf-8", mode: 0o600 },
      )

      const result = writeBackCredentials("file", {
        accessToken: "new-at",
        refreshToken: "new-rt",
        expiresAt: 2000,
      })

      assert.equal(result, true)
      const written = JSON.parse(readFileSync(credPath, "utf-8"))
      assert.equal(written.claudeAiOauth.accessToken, "new-at")
    } finally {
      if (typeof originalHome === "string") process.env.HOME = originalHome
      else delete process.env.HOME
      if (typeof originalConfigDir === "string")
        process.env.CLAUDE_CONFIG_DIR = originalConfigDir
      else delete process.env.CLAUDE_CONFIG_DIR
      rmSync(tempHome, { recursive: true, force: true })
      rmSync(configDir, { recursive: true, force: true })
    }
  })
})

describe("writeBackCredentials (keychain source)", () => {
  // The keychain is the primary platform and the reason the compare-and-swap
  // guard exists, so it needs its own coverage: the file-source tests cannot
  // reach this branch, and `process.platform` is rewritten to "darwin" by the
  // harness so these run on any host.
  const SERVICE = "Claude Code-credentials"
  const DUMP = genpDump([{ service: SERVICE }])

  const blob = (accessToken: string) =>
    JSON.stringify({
      claudeAiOauth: {
        accessToken,
        refreshToken: `rt-for-${accessToken}`,
        expiresAt: 1000,
        subscriptionType: "max",
      },
    })

  const refreshed = {
    accessToken: "our-refreshed-at",
    refreshToken: "our-refreshed-rt",
    expiresAt: 2000,
  }

  it("skips the write when the stored token is no longer the expected one", async () => {
    const { writeBackCredentials, __getSecurityWrites } =
      await loadKeychainWithMockedSecurity(DUMP, {
        // Another account was switched in after we read "expected-at".
        [SERVICE]: blob("switched-in-at"),
      })

    const result = writeBackCredentials(
      SERVICE,
      refreshed,
      undefined,
      "expected-at",
    )

    assert.equal(result, false)
    assert.deepEqual(
      __getSecurityWrites(),
      [],
      "the switched-in credential must survive untouched",
    )
  })

  it("writes when the stored token still matches the expected one", async () => {
    const { writeBackCredentials, __getSecurityWrites } =
      await loadKeychainWithMockedSecurity(DUMP, {
        [SERVICE]: blob("expected-at"),
      })

    const result = writeBackCredentials(
      SERVICE,
      refreshed,
      undefined,
      "expected-at",
    )

    assert.equal(result, true)
    const writes = __getSecurityWrites()
    assert.equal(writes.length, 1)
    assert.equal(writes[0].service, SERVICE)
    const written = JSON.parse(writes[0].value) as {
      claudeAiOauth: { accessToken: string; subscriptionType: string }
    }
    assert.equal(written.claudeAiOauth.accessToken, "our-refreshed-at")
    assert.equal(
      written.claudeAiOauth.subscriptionType,
      "max",
      "unrelated fields must be preserved",
    )
  })

  it("writes without a guard when no expected token is supplied", async () => {
    const { writeBackCredentials, __getSecurityWrites } =
      await loadKeychainWithMockedSecurity(DUMP, {
        [SERVICE]: blob("whatever-is-there"),
      })

    assert.equal(writeBackCredentials(SERVICE, refreshed), true)
    assert.equal(__getSecurityWrites().length, 1)
  })
})

describe("readAllClaudeAccounts (file source)", () => {
  it("reads credentials from CLAUDE_CONFIG_DIR when set", async () => {
    // Non-darwin reads go straight to the credentials file; on darwin the
    // keychain is tried first, so this only asserts deterministically off-mac.
    if (process.platform === "darwin") return

    const originalHome = process.env.HOME
    const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    const tempHome = await mkdtemp(
      join(tmpdir(), "opencode-claude-auth-rd-home-"),
    )
    const configDir = await mkdtemp(
      join(tmpdir(), "opencode-claude-auth-rd-cfg-"),
    )
    process.env.HOME = tempHome
    process.env.CLAUDE_CONFIG_DIR = configDir

    try {
      writeFileSync(
        join(configDir, ".credentials.json"),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "cfg-at",
            refreshToken: "cfg-rt",
            expiresAt: 1700000000000,
            subscriptionType: "pro",
          },
        }),
        { encoding: "utf-8", mode: 0o600 },
      )

      const accounts = readAllClaudeAccountsReal()
      assert.equal(accounts.length, 1)
      assert.equal(accounts[0].source, "file")
      assert.equal(accounts[0].credentials.accessToken, "cfg-at")
    } finally {
      if (typeof originalHome === "string") process.env.HOME = originalHome
      else delete process.env.HOME
      if (typeof originalConfigDir === "string")
        process.env.CLAUDE_CONFIG_DIR = originalConfigDir
      else delete process.env.CLAUDE_CONFIG_DIR
      rmSync(tempHome, { recursive: true, force: true })
      rmSync(configDir, { recursive: true, force: true })
    }
  })
})

function makeCreds(accessToken: string) {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken,
      refreshToken: "rt",
      expiresAt: Date.now() + 3_600_000,
    },
  })
}

describe("CLAUDE_CONFIG_DIR support", () => {
  const savedEnv = process.env.CLAUDE_CONFIG_DIR

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = savedEnv
    }
  })

  it("uses ~/.claude by default when CLAUDE_CONFIG_DIR is unset", async () => {
    const originalHome = process.env.HOME
    delete process.env.CLAUDE_CONFIG_DIR
    const fakeHome = await mkdtemp(join(tmpdir(), "claude-home-"))
    const defaultDir = join(fakeHome, ".claude")
    mkdirSync(defaultDir, { recursive: true })
    writeFileSync(
      join(defaultDir, ".credentials.json"),
      makeCreds("default-token"),
    )

    process.env.HOME = fakeHome

    try {
      const creds = readCredentialsFile()
      assert.ok(creds)
      assert.equal(creds.accessToken, "default-token")
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = originalHome
      }
      rmSync(fakeHome, { recursive: true, force: true })
    }
  })

  it("uses CLAUDE_CONFIG_DIR when set to a custom path", async () => {
    const customDir = await mkdtemp(join(tmpdir(), "claude-custom-"))
    mkdirSync(customDir, { recursive: true })
    writeFileSync(
      join(customDir, ".credentials.json"),
      makeCreds("custom-token"),
    )

    process.env.CLAUDE_CONFIG_DIR = customDir

    const creds = readCredentialsFile()
    assert.ok(creds)
    assert.equal(creds.accessToken, "custom-token")

    rmSync(customDir, { recursive: true, force: true })
  })

  it("works with arbitrary custom directory names", async () => {
    const arbitraryDir = await mkdtemp(join(tmpdir(), "claude-arbitrary-"))
    writeFileSync(
      join(arbitraryDir, ".credentials.json"),
      makeCreds("arbitrary-token"),
    )

    process.env.CLAUDE_CONFIG_DIR = arbitraryDir

    const creds = readCredentialsFile()
    assert.ok(creds)
    assert.equal(creds.accessToken, "arbitrary-token")

    rmSync(arbitraryDir, { recursive: true, force: true })
  })
})

describe("keychainSuffixForDir", () => {
  it("derives the expected suffix for a known path", () => {
    assert.equal(keychainSuffixForDir("/Users/example/.work"), "d4b84687")
  })

  it("produces different suffixes for different dirs", () => {
    const a = keychainSuffixForDir("/Users/example/.claude")
    const b = keychainSuffixForDir("/Users/example/.work")
    const c = keychainSuffixForDir("/Users/example/.personal")
    assert.notEqual(a, b)
    assert.notEqual(b, c)
    assert.notEqual(a, c)
  })

  it("produces 8-character hex strings", () => {
    const suffix = keychainSuffixForDir("/Users/example/.claude")
    assert.match(suffix, /^[0-9a-f]{8}$/)
  })

  it("is consistent for the same input", () => {
    const dir = join(homedir(), ".someconfig")
    assert.equal(keychainSuffixForDir(dir), keychainSuffixForDir(dir))
  })
})
