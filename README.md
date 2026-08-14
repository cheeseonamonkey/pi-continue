# pi-continue

[![npm version](https://img.shields.io/npm/v/@ffatty/pi-continue?color=cb3837)](https://www.npmjs.com/package/@ffatty/pi-continue)

A tiny [Pi](https://github.com/earendil-works/pi-coding-agent) extension for
recovering an interrupted agent turn: with an empty editor and an idle agent,
double-tap **Enter** to send `"(continue...)"`.

It is especially useful after an accidental **Esc**. The first press arms the
shortcut; the second press, within the configured window, resumes the agent.

## Install

```bash
pi install npm:@ffatty/pi-continue
```

For a checkout under development:

```bash
pi -e .
```

## How it works

| Action | Result |
| --- | --- |
| First configured keypress, empty editor, agent idle | Arms the extension and displays a hint |
| Second keypress before the timeout | Continues the agent |
| Any other key or timeout | Disarms without submitting anything |
| Editor has text, or agent is busy | Native Pi editor behavior is preserved exactly |

The extension wraps Pi's editor and delegates all non-double-tap input to the
native editor. Normal submissions, slash commands, `!bash`, autocomplete, and
streaming controls therefore continue to work normally.

### Safe rewind

By default, `pi-continue` also recognizes an essentially empty interrupted
turn. If the latest user message has only a tiny amount of assistant output
(10 estimated tokens by default) after it—and no tool results, custom
messages, or bash output—it creates a fork at that user message, then
continues in the fork. This drops the partial response from the active context
without destroying it: the original session branch remains available in Pi's
tree.

Set `"rewindEmptyTurn": false` to always continue in the current branch, or
set `"rewindMaxAssistantTokens": 0` to require absolutely no assistant output.

## Configuration

Configuration is layered; later files override earlier files:

1. Package defaults: `double-tap-continue.config.json`
2. Global overrides: `~/.pi/agent/double-tap-continue.json`
3. Project overrides: `<project>/.pi/double-tap-continue.json`

Create either override file with only the values you want to change:

```json
{
  "enabled": true,
  "shortcutKey": "enter",
  "armedWidgetText": "Press Enter again to continue…",
  "armTimeoutMs": 1500,
  "continueMessage": "(continue...)",
  "rewindEmptyTurn": true,
  "rewindMaxAssistantTokens": 10,
  "deleteMessageAfterSend": false
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Enables or disables the extension. |
| `shortcutKey` | `"enter"` | Double-tap key, such as `"enter"`, `"ctrl+enter"`, or `"alt+enter"`. |
| `armedWidgetText` | `"Press Enter again to continue…"` | Hint shown while armed. |
| `armTimeoutMs` | `1500` | Time to wait for the second press, in ms (100–10000). |
| `continueMessage` | `"(continue...)"` | Message sent to the agent. |
| `rewindEmptyTurn` | `true` | Fork from a nearly empty interrupted turn before continuing. |
| `rewindMaxAssistantTokens` | `10` | Assistant-output limit for rewinding (0–1000 estimated tokens). |
| `deleteMessageAfterSend` | `false` | When true, sends the continuation silently: it enters model context but is not rendered in the transcript. |

Run `/reload` (or restart Pi) after changing configuration. Run
`/double-tap-continue` to inspect the effective values and every configuration
path consulted.

## Development

```bash
git clone https://github.com/cheeseonamonkey/pi-continue.git
cd pi-continue
pi -e .
```

The package intentionally has no runtime npm dependencies. Pi provides its
extension APIs as peer dependencies.

## Releases

Pushing a `v*` Git tag (or manually running the **Publish to npm** GitHub
Actions workflow) publishes the version declared in `package.json`. Repository
maintainers must configure the repository `NPM_TOKEN` Actions secret with an
npm publish-capable token.

## License

[MIT](LICENSE)
