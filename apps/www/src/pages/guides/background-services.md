---
layout: ../../layouts/GuideLayout.astro
locale: en
slug: background-services
---

`codesesh hub start` and `codesesh worker start` register background tasks for the current user, so you can close the terminal after startup. Use the Hub for the web interface and a paired Worker for collection. Plain `codesesh hub` runs in the foreground instead.

## Prepare a paired setup

Install the command and follow the [Hub and Worker guide](/guides/multi-machine-sync/) if this is your first setup. A Hub alone serves stored history; it does not collect the current machine. Stop standalone mode before using background Hub and Worker with the same data directory.

For a local-only Hub:

```sh
codesesh hub start
codesesh hub status
codesesh hub open
```

For LAN settings, use the complete command from the [LAN guide](/guides/lan-access/) on first start. After pairing a Worker, start it again without supplying a new token:

```sh
codesesh worker start
codesesh worker status
```

A Worker previously paired in the foreground can reuse its saved Hub address and credentials. If no background configuration exists yet, collection options use the current arguments and defaults. Supply `--agent` explicitly if you need a restricted set.

## Wait for readiness

`start` waits approximately ten seconds. A long initialization continues in the background. Follow its status without stopping the service:

```sh
codesesh hub status --watch
codesesh worker status --watch
```

Ctrl+C exits the status watcher, not the background task. Once the Hub is ready, `codesesh hub open` opens its console. A connected Worker may still have uploads pending.

## Restart or change configuration

For a normal restart:

```sh
codesesh hub restart
codesesh worker restart
```

A restart reuses the saved arguments. To change them, stop the relevant service, then start it with the full intended configuration. For example:

```sh
codesesh hub stop
codesesh hub start --host 0.0.0.0 --remote-access --port 4521
```

To stop both services:

```sh
codesesh worker stop
codesesh hub stop
```

Stopping does not delete the archive or Worker queue. If stop reports a timeout, check status again before assuming the process has exited.

## Upgrade the executable

For an npm installation, stop services, update the package, and register the new executable by starting again:

```sh
codesesh worker stop
codesesh hub stop
npm install --global codesesh@latest
codesesh --version
codesesh hub start
codesesh worker start
```

For a native installation, replace the executable using the installer or release archive between stop and start. On multiple machines, upgrade the Hub before Workers. `restart` alone does not register the path of a newly installed binary.

## Locate logs and understand session limits

`status` prints the configured log locations. Defaults are:

- `~/.codesesh/services/hub.log` and `worker.log`: service stdout and stderr, including startup failures.
- `~/.codesesh/logs/codesesh-*.log`: structured application logs for each process, with rotation.

A quiet service log does not mean application logging is disabled. Check both locations. Do not share files from `services/*.json`; they may contain credentials. Check logs for private information before attaching them to an issue.

macOS uses a user launchd task, Linux uses a systemd user unit, and Windows uses Task Scheduler for the logged-in user. These commands do not enable boot or login autostart. macOS and Windows require the applicable logged-in user session; Linux requires a working systemd user environment. Running after logout is outside this service setup's guarantees.
