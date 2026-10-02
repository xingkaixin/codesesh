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
  return (
    <label className="flex items-center gap-2 text-xs text-[var(--console-muted)]">
      <span className="console-eyebrow shrink-0">{t("Source node")}</span>
      <NativeSelect
        className="console-mono rounded-full bg-[var(--console-surface-muted)] py-1 pl-2.5 text-[10px]"
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
      </NativeSelect>
    </label>
  );
}
