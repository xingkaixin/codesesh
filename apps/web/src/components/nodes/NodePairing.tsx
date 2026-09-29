import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AppConfig } from "@codesesh/contract";
import { createPairingToken, fetchPairingStatus } from "../../lib/api";
import { useNodeClock } from "../../hooks/useNodes";
import { t } from "../../i18n/translate";
import { NativeSelect } from "../ui/native-select";
import { nodeButton } from "./NodeDialog";
import { CopyButton } from "./CopyButton";
import { pairingCommand, type ConnectionScope } from "./pairing-command";

export function NodePairing({ token, expires }: { token: string; expires: number }) {
  const client = useQueryClient();
  const configured = client.getQueryData<AppConfig>(["config"])?.publicHubUrl;
  const initialAddress = configured ?? window.location.origin;
  const initialScope = pairingCommand(initialAddress, "local", false)
    ? "local"
    : initialAddress.startsWith("https:")
      ? "public"
      : "lan";
  const [scope, setScope] = useState<ConnectionScope>(initialScope);
  const [address, setAddress] = useState(initialAddress);
  const [background, setBackground] = useState(false);
  const [pairing, setPairing] = useState({ token, expires });
  const [renewing, setRenewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useNodeClock();
  const status = useQuery({
    queryKey: ["pairing-status", pairing.token],
    queryFn: async () => {
      const result = await fetchPairingStatus(pairing.token);
      if (result.nodeId) void client.invalidateQueries({ queryKey: ["source-nodes"] });
      return result;
    },
    refetchInterval: (query) => (query.state.data?.nodeId ? false : 5000),
    retry: false,
  });
  const command = pairingCommand(address, scope, background);
  const renew = async () => {
    setRenewing(true);
    setError(null);
    try {
      const value = await createPairingToken();
      setPairing({ token: value.token, expires: Date.now() + value.expiresInSeconds * 1000 });
    } catch {
      setError(t("Unable to create a new token. Try again."));
    } finally {
      setRenewing(false);
    }
  };
  if (status.data?.nodeId)
    return (
      <div className="mt-6 space-y-3" role="status">
        <p className="text-sm font-medium text-[var(--console-success)]">
          {t("Worker paired successfully")}
        </p>
        <p className="break-all text-xs text-[var(--console-muted)]">
          {t("Source node: {0}", [status.data.nodeId])}
        </p>
        <p className="text-sm">{t("Check collection and upload progress in Source nodes.")}</p>
      </div>
    );
  return (
    <div className="mt-6 space-y-5">
      <label className="block space-y-2 text-sm">
        <span className="block">{t("Connection")}</span>
        <NativeSelect
          aria-label={t("Connection")}
          value={scope}
          onChange={(event) => {
            const next = event.target.value as ConnectionScope;
            setScope(next);
            setAddress(
              next === "local"
                ? `http://127.0.0.1:${window.location.port || "4521"}`
                : next === "public"
                  ? (configured ??
                    (window.location.protocol === "https:" ? window.location.origin : ""))
                  : initialScope === "lan"
                    ? initialAddress
                    : "",
            );
          }}
        >
          <option value="local">{t("This machine")}</option>
          <option value="lan">{t("Local network")}</option>
          <option value="public">{t("Public network")}</option>
        </NativeSelect>
      </label>
      <label className="block space-y-2 text-sm">
        <span className="block">{t("Hub address reachable from the Worker")}</span>
        <input
          aria-label={t("Hub address reachable from the Worker")}
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          placeholder={scope === "lan" ? "http://192.168.1.10:4521" : "https://history.example.com"}
          spellCheck={false}
          className="w-full rounded-md border border-[var(--console-border)] bg-[var(--console-surface)] px-3 py-2 text-sm"
        />
        <span className="block text-xs text-[var(--console-muted)]">
          {scope === "local"
            ? t("Loopback addresses work only on the Hub machine.")
            : scope === "lan"
              ? t(
                  "Use a LAN IP or hostname. HTTP is unencrypted; use it only on a trusted network. Worker verifies the resolved addresses.",
                )
              : t("Public connections require HTTPS with a trusted certificate.")}
        </span>
      </label>
      {scope === "lan" && (
        <p className="text-xs text-[var(--console-muted)]">
          {t(
            "Hub must listen on a LAN interface with --remote-access. Allow its port through the firewall.",
          )}
        </p>
      )}
      <label className="block space-y-2 text-sm">
        <span className="block">{t("Run mode")}</span>
        <NativeSelect
          aria-label={t("Run mode")}
          value={background ? "background" : "foreground"}
          onChange={(event) => setBackground(event.target.value === "background")}
        >
          <option value="foreground">{t("Foreground — try the connection")}</option>
          <option value="background">{t("Background service — keep collecting")}</option>
        </NativeSelect>
        <span className="block text-xs text-[var(--console-muted)]">
          {background
            ? t(
                "Continues after closing the terminal. Manage it with codesesh worker status, stop, or restart. Autostart is not enabled.",
              )
            : t("Runs in this terminal. Press Ctrl+C to stop.")}
        </span>
      </label>
      <div className="space-y-3 rounded-lg border border-[var(--console-border)] bg-[var(--console-surface)] p-4">
        {command ? (
          <>
            <code className="block break-all text-xs">{command}</code>
            <CopyButton value={command} label={t("Copy command")} />
          </>
        ) : (
          <p role="status" className="text-sm text-[var(--console-warning)]">
            {t("Enter a valid Hub origin for the selected connection type.")}
          </p>
        )}
      </div>
      <label className="block space-y-2 text-sm">
        <span className="block">{t("One-time pairing token")}</span>
        <textarea
          readOnly
          value={pairing.token}
          className="console-mono w-full resize-none rounded-md border border-[var(--console-border)] bg-[var(--console-surface)] p-3 text-xs"
        />
      </label>
      <CopyButton value={pairing.token} label={t("Copy token")} disabled={now >= pairing.expires} />
      <p role="status" className="text-xs text-[var(--console-muted)]">
        {now >= pairing.expires
          ? t("Pairing token expired. Generate a new token below.")
          : t("Expires at {0}. Paste it into the Worker prompt.", [
              new Date(pairing.expires).toLocaleTimeString(),
            ])}
      </p>
      {now >= pairing.expires && (
        <button
          className={nodeButton}
          disabled={renewing}
          onClick={() => {
            void renew();
          }}
        >
          {t("Generate new token")}
        </button>
      )}
      {status.isError && (
        <p role="status" className="text-xs text-[var(--console-warning)]">
          {t("Pairing status unavailable. Check the Worker terminal or retry.")}{" "}
          <button
            className={nodeButton}
            onClick={() => {
              void status.refetch();
            }}
          >
            {t("Retry")}
          </button>
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-[var(--console-error)]">
          {error}
        </p>
      )}
    </div>
  );
}
