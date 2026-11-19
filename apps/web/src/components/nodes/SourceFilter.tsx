import { NativeSelect } from "../ui/native-select";
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
  const sourceCount = (nodes.data.local ? 1 : 0) + nodes.data.nodes.length;
  if (sourceCount <= 1 && !value) return null;
  const hasKnownValue =
    !value ||
    (value === "local" && Boolean(nodes.data.local)) ||
    nodes.data.nodes.some((node) => node.id === value);
  return (
    <NativeSelect
      aria-label={t("Source node")}
      className="h-7 rounded-lg border-[var(--console-border)] bg-[var(--console-bg)] py-0 pl-3 text-xs font-medium shadow-[var(--shadow-raised)]"
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
      {!hasKnownValue && value ? <option value={value}>{value}</option> : null}
    </NativeSelect>
  );
}
