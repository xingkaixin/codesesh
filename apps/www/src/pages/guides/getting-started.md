---
layout: ../../layouts/GuideLayout.astro
locale: en
slug: getting-started
---

CodeSesh opens a local web interface for browsing supported AI coding histories, including Claude Code and Codex. You can try it with one command or install a standalone executable. You need existing session records on the machine; CodeSesh does not create conversations for you.

## Choose an installation method

With Node.js 22 or later, try CodeSesh without a global installation:

```sh
npx codesesh
```

For regular use on macOS, Linux, or Windows, install the command:

```sh
npm install --global codesesh
codesesh --version
codesesh
```

If you do not want a Node.js dependency, use the native installer on macOS or Linux:

```sh
curl -sSfL https://codesesh.xingkaixin.me/install.sh | sh
```

The installer downloads a platform-specific executable. Windows users can also download the appropriate native archive from [GitHub Releases](https://github.com/xingkaixin/codesesh/releases). Use the executable for your operating system and architecture. The standalone executable does not require Node.js.

## Open the local interface

CodeSesh prints a URL and normally opens your browser. The default address is `http://127.0.0.1:4521/`; if it chooses another port, use the printed URL. Keep this terminal running while browsing. Press Ctrl+C to stop the foreground server.

Default access is local to the machine. To require a token even locally, start with `codesesh --auth` and open its printed link. To browse from another device, follow the [LAN access guide](/guides/lan-access/).

## Choose the history to display

The default window includes sessions active in the last seven local calendar days. Use all available history when you are searching for an older conversation:

```sh
codesesh --days 0
```

To limit the view to your current project and two agents:

```sh
codesesh --cwd . --agent claudecode,codex --days 0
```

Run the command from the project directory. For a fixed date range, supply local calendar dates:

```sh
codesesh --from 2026-09-01 --to 2026-09-30
```

An explicit `--from` overrides the default day window. Large archives need time for initial indexing. Read [how to find session history](/guides/session-history/) for source directories, search, and missing-session checks.

## Pick standalone or Hub mode

`codesesh` scans the current machine and serves its web interface in one process. A Hub serves stored data, while Workers collect and upload it. Use [Hub and Worker](/guides/multi-machine-sync/) when you want several machines in one interface, or [background services](/guides/background-services/) to keep that setup running after closing the terminal.

Stop any standalone CodeSesh process before starting Hub and Worker with the same data directory. Do not run the two modes against that directory at the same time.
