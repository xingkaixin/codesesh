---
layout: ../../layouts/GuideLayout.astro
locale: en
slug: multi-machine-sync
---

CodeSesh can collect AI coding history from multiple computers into one Hub. Run the Hub on the computer where you want to browse the combined archive, then pair a Worker on each machine that holds source sessions. Workers upload to your Hub; the Hub does not scan its own machine automatically.

## Start the Hub and open its console

Install CodeSesh on the participating machines. For a Hub that accepts connections on a trusted LAN, stop any existing standalone process and start:

```sh
codesesh hub start --host 0.0.0.0 --remote-access --port 4521
codesesh hub status
```

If a Hub is already running with different settings, stop it before starting with these arguments. Follow the [LAN access guide](/guides/lan-access/) to open the token-bearing console link and check the firewall. For a Hub reachable over the public internet, use HTTPS with a certificate trusted by Workers.

## Pair the first Worker

In the Hub web interface, open **Source nodes** and create a pairing token. On the machine to collect, run:

```sh
codesesh worker start --hub http://192.168.1.20:4521 --name laptop --pair-token-stdin
```

Replace the example IP with your Hub's address. Paste the pairing token at the prompt. It expires after ten minutes and can be used once. `--pair-token-stdin` keeps it out of the command arguments and shell history.

The browser access token is not a pairing token. After pairing, the Worker stores its own credentials and does not need a new pairing token for normal restarts.

## Collect the Hub computer too

Create another pairing token in the console and run a separate local Worker:

```sh
codesesh worker start --hub http://127.0.0.1:4521 --name desktop --pair-token-stdin
```

Repeat pairing for every other machine. Each should have its own Worker state and pairing. To restrict collection, include `--agent claudecode,codex` in the initial Worker configuration. By default, Workers collect all discoverable history for enabled agents; the Hub's time range controls what you view.

When a Worker connects to a different Hub and discovers an older standalone database, it may require `--history import` or `--history ignore`. Import includes that archived history; ignore skips the old archive but still collects available source logs. Choose deliberately before retrying the full pairing command with that flag. A same-directory local Worker paired to its own Hub can reuse the existing local history without this choice.

## Check synchronization

```sh
codesesh worker status
codesesh hub status
```

The Source nodes page shows recent contact, pending batches, bytes, and collection errors. Pending batches are protocol operations, not a count of conversations. A Worker can be connected while still uploading a backlog; browsing older data does not mean every upload has finished.

If the Hub is offline, the Worker continues collecting and keeps pending uploads in its local database. Let it reconnect with its saved credentials. Do not delete Worker state to fix a temporary network problem. For credential or version failures, follow the reported reason and upgrade the Hub before Workers.

## Browse across sources

Use the source selector to inspect one node or the combined view. Project grouping does not grant one Worker permission to impersonate another source. This setup is an archive viewer with a console access token, not a per-user workspace with separate account permissions.

To restart, change configuration, or locate logs, continue with [background services](/guides/background-services/).
