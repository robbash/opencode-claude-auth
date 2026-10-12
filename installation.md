# Install opencode-claude-auth

These instructions are designed for AI coding agents.

## Prerequisites

Before installing, verify you have OpenCode and Claude Code installed and authenticated.

### Check OpenCode version

```bash
opencode --version
```

You should see a version number. **This plugin requires OpenCode v2** (version
`2.x`). If `opencode --version` reports `1.x`, either upgrade OpenCode or pin the
previous plugin major instead: `"plugin": ["opencode-claude-auth@1"]`.

### Check Claude Code credentials (macOS)

```bash
security find-generic-password -s "Claude Code-credentials" -w
```

If this returns credentials, you're authenticated. If it fails or returns nothing, try the fallback:

### Check Claude Code credentials (fallback for all platforms)

```bash
cat ~/.claude/.credentials.json
```

If this file exists and contains valid JSON, you're authenticated. If `CLAUDE_CONFIG_DIR` is set, check `$CLAUDE_CONFIG_DIR/.credentials.json` instead.

### If credentials don't exist

Run Claude Code to authenticate:

```bash
claude
```

This will prompt you to log in and store credentials in Keychain (macOS) or `~/.claude/.credentials.json` (other platforms; `$CLAUDE_CONFIG_DIR/.credentials.json` if `CLAUDE_CONFIG_DIR` is set).

## Installation

### Step 1: Add to OpenCode configuration

Edit the OpenCode configuration file at `~/.config/opencode/opencode.json`.

Add `opencode-claude-auth@latest` to the `plugins` array. Note the key is
`plugins` (plural) in OpenCode v2 — v1 used `plugin`:

```json
{
  "plugins": ["opencode-claude-auth@latest"]
}
```

Or run this command to do it automatically:

```bash
node -e "
const fs = require('fs'), p = require('path').join(require('os').homedir(), '.config/opencode/opencode.json');
const c = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p,'utf8')) : {};
c.plugins = [...new Set([...(Array.isArray(c.plugins) ? c.plugins : []), 'opencode-claude-auth@latest'])];
delete c.plugin;
fs.mkdirSync(require('path').dirname(p), {recursive:true});
fs.writeFileSync(p, JSON.stringify(c, null, 2));
console.log('Added opencode-claude-auth@latest to', p);
"
```

The `@latest` tag ensures OpenCode always pulls the newest version on startup. No manual `npm install` is needed — OpenCode installs npm plugins at startup.

### Step 2: Verification

Verify the plugin was added:

```bash
cat ~/.config/opencode/opencode.json
```

You should see `opencode-claude-auth@latest` in the `plugins` array.

## Upgrading

Coming from plugin 2.x, two config changes are required:

1. Rename `plugin` to `plugins`.
2. Make sure OpenCode itself is on v2.

If you previously installed `opencode-claude-auth` without the `@latest` tag, update your config to use `opencode-claude-auth@latest` as shown above.

If the plugin isn't picking up a new version, clear the cached package and restart OpenCode:

```bash
rm -rf ~/.cache/opencode/packages/opencode-claude-auth@latest/
```

## Done

The plugin is now installed and configured. When you run OpenCode, it will automatically use your Claude Code credentials — no separate login needed.

## Troubleshooting

If you encounter issues, see the [main README troubleshooting section](README.md#troubleshooting).
