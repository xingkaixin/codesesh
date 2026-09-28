import { useNodes } from "../../hooks/useNodes";
import { useLocale } from "../../hooks/useLocale";
import { t } from "../../i18n/translate";

export function SourceFilter({
  value,
  onChange,
}: {
  value?: string;
  onChange: (value?: string) => void;
}) {
  useLocale();
  const nodes = useNodes();
  if (!nodes.data) return null;
  return (
    <label className="flex items-center gap-2 text-xs text-[var(--console-muted)]">
      {t("Source node")}
      <select
        className="rounded-sm border border-[var(--console-border)] bg-[var(--console-surface)] px-2 py-1.5 text-sm text-[var(--console-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value || undefined)}
      >
        <option value="">{t("All sources")}</option>
        {nodes.data.local && <option value="local">{t("Local source")}</option>}
        {nodes.data.nodes.map((node) => (
          <option key={node.id} value={node.id}>
            {node.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export function SourceBadge({ sourceNodeId }: { sourceNodeId: string }) {
  useLocale();
  const nodes = useNodes();
  const local = sourceNodeId === "local";
  return (
    <span
      className="text-xs text-[var(--console-muted)]"
      title={
        local ? undefined : t("Paths belong to the source machine. Files are not transferred.")
      }
    >
      {t("Source: {0}", [
        local
          ? t("Local source")
          : (nodes.data?.nodes.find((node) => node.id === sourceNodeId)?.name ?? sourceNodeId),
      ])}
    </span>
  );
}
