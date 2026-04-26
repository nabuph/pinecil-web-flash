import type { FlashPhase, PinecilModel, TransportKind } from "@/lib/types";

interface IronSchematicProps {
  model?: PinecilModel;
  connected: boolean;
  flashing: boolean;
  transport?: TransportKind;
}

export function IronSchematic({ model, connected, flashing, transport }: IronSchematicProps) {
  return (
    <svg
      className="iron-schematic"
      viewBox="0 0 200 52"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label={connected ? `${model?.toUpperCase() ?? "Pinecil"} connected` : "No device connected"}
      data-connected={connected ? "true" : "false"}
      data-flashing={flashing ? "true" : "false"}
      data-transport={transport ?? "none"}
    >
      {/* Tip — pointed left */}
      <path
        className="iron-tip-path"
        d="M4 26 L38 16 L38 36 Z"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />

      {/* Body — main rounded rectangle */}
      <rect
        className="iron-body-path"
        x="38"
        y="13"
        width="136"
        height="26"
        rx="5"
        strokeWidth="1.5"
      />

      {/* OLED screen cutout */}
      <rect
        className="iron-body-path"
        x="52"
        y="20"
        width="30"
        height="12"
        rx="2"
        strokeWidth="1"
        opacity="0.55"
      />

      {/* Model text */}
      <text
        x="100"
        y="30"
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize="8"
        fontFamily="var(--font-mono, monospace)"
        fontWeight="600"
        fill="currentColor"
        opacity="0.45"
      >
        {model ? model.toUpperCase() : "—"}
      </text>

      {/* Grip lines */}
      <line className="iron-body-path" x1="120" y1="17" x2="120" y2="35" strokeWidth="1" opacity="0.3" />
      <line className="iron-body-path" x1="128" y1="17" x2="128" y2="35" strokeWidth="1" opacity="0.3" />
      <line className="iron-body-path" x1="136" y1="17" x2="136" y2="35" strokeWidth="1" opacity="0.3" />

      {/* USB-C connector */}
      <rect
        className="iron-connector"
        x="174"
        y="20"
        width="18"
        height="12"
        rx="3"
        strokeWidth="1.5"
      />

      {/* USB-C inner oval */}
      <ellipse
        className="iron-connector"
        cx="183"
        cy="26"
        rx="4"
        ry="2.5"
        strokeWidth="1"
        opacity="0.6"
      />

      {/* Status dot — top-right of body */}
      <circle
        className="iron-status-dot"
        cx="162"
        cy="18"
        r="3"
      />
    </svg>
  );
}

export function flashingPhase(phase: FlashPhase): boolean {
  return phase === "validate" || phase === "flash" || phase === "verify";
}
