---
layout: ../../layouts/GuideLayout.astro
locale: en
slug: lan-access
---

To open a CodeSesh Hub both locally and from another device on your network, bind it to `0.0.0.0` and enable `--remote-access`. Use the Hub computer's LAN IP from the other device and keep the access token from the printed console link. The default `127.0.0.1` listener accepts connections only from the Hub computer itself.

## Start the Hub on a fixed port

Install the `codesesh` command first using the [installation guide](/guides/getting-started/). If you are running standalone mode, stop it with Ctrl+C. If a background Hub is already running, stop it before changing its configuration:

```sh
codesesh hub stop
```

Start the Hub with the new settings:

```sh
codesesh hub start --host 0.0.0.0 --remote-access --port 4521
codesesh hub status
```

`0.0.0.0` listens on all IPv4 interfaces, including loopback and your LAN interface. It is a listening address; use a concrete IP in the browser. A Hub does not scan this machine automatically. If the interface has no sessions, add a Worker using the [multi-machine guide](/guides/multi-machine-sync/).

## Open the console from either device

Copy the complete `Console` URL from `hub status`. It contains `access_token`. Replace only the host in that URL:

- On the Hub computer, use `127.0.0.1`.
- On another device, use the Hub computer's LAN IP, for example `192.168.1.20`.

Find the IP in the Hub computer's network settings. Do not use `127.0.0.1` on the other device: that address refers to the other device itself. Keep the port and token unchanged.

Remote access requires token authentication even when you visit through loopback. Each Hub process generates a new token, so get a fresh link after a restart. The browser console token is separate from the pairing token used by Workers.

## Check connection failures

1. Open the console on the Hub computer first and confirm `codesesh hub status` says it is ready.
2. Check that the other device uses the correct LAN IP and port. A DHCP address change can make an old link stop working.
3. Allow inbound TCP port 4521 in the Hub computer's firewall. Guest Wi-Fi or client isolation may block communication between devices.
4. If the page opens but requests report that a token is required, obtain the current `Console` link again.

Starting with just `codesesh hub start` later reuses saved settings. To change the address or port again, stop the service and run `start` with the full desired arguments. `restart` reuses the saved configuration.

## Choose HTTP or HTTPS

The command above uses unencrypted HTTP. Use it on a trusted local network. For networks where you need transport encryption, CodeSesh can terminate TLS with your certificate and key:

```sh
codesesh hub start --host 0.0.0.0 --remote-access --port 4521 \
  --tls-cert /path/to/cert.pem --tls-key /path/to/key.pem
```

Stop the existing Hub before using this replacement configuration. The certificate must be trusted by clients and valid for the address they use. For an HTTPS reverse proxy, the backend must stay on a loopback address; see the [remote-access configuration](https://github.com/xingkaixin/codesesh/blob/main/README.md). An access token authenticates a request but does not encrypt HTTP traffic.
