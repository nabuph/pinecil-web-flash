import { ShieldCheck, Plug } from "lucide-react";
import type { ElementType } from "react";

const safetyItems = [
  "Flash mode is active.",
  "The DC barrel jack is disconnected.",
  "USB power will stay connected during write and verify."
];

export function SafetyChecklist({
  children,
  disabled,
  onChange,
  values
}: {
  children?: React.ReactNode;
  disabled: boolean;
  onChange(value: boolean[]): void;
  values: boolean[];
}) {
  return (
    <div className="safety-checklist">
      <div className="safety-checklist-heading">
        <ShieldCheck size={13} />
        Safety
      </div>
      <div className="safety-checklist-items">
        {safetyItems.map((copy, index) => (
          <label className="safety-item" key={copy}>
            <input
              checked={values[index]}
              disabled={disabled}
              onChange={(e) =>
                onChange(values.map((v, i) => (i === index ? e.target.checked : v)))
              }
              type="checkbox"
            />
            {copy}
          </label>
        ))}
        {children}
      </div>
    </div>
  );
}

export function EmptyConnectNotice() {
  return (
    <div className="empty-notice">
      <Plug size={15} />
      Connect a Pinecil first. The app detects V1 (DFU) vs V2 (BLISP) from the flash mode chip.
    </div>
  );
}

export function InfoRows({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="info-rows">
      {rows.map(([label, value]) => (
        <div className="info-row" key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function StatusChip({
  label,
  title,
  tone
}: {
  label: string;
  title?: string;
  tone: "green" | "amber" | "red" | "gray";
}) {
  return (
    <span className="chip" data-tone={tone} title={title}>
      {label}
    </span>
  );
}

export function FileInput({
  accept,
  disabled,
  icon: Icon,
  label,
  onFile
}: {
  accept: string;
  disabled?: boolean;
  icon: ElementType;
  label: string;
  onFile(file: File): void;
}) {
  return (
    <label className="file-pick" data-disabled={disabled ? "true" : "false"}>
      <Icon size={14} />
      {label}
      <input
        accept={accept}
        disabled={disabled}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = "";
        }}
        type="file"
      />
    </label>
  );
}
