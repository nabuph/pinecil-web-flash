"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Check, CheckCircle2, Info, Loader2, Moon, Monitor, Plug, Sun, Upload, XCircle, Zap } from "lucide-react";
import { Pine64Logo } from "@/components/pine64-logo";
import { IronSchematic } from "@/components/iron-schematic";
import { StatusChip, InfoRows, SafetyChecklist, EmptyConnectNotice } from "@/components/shared";

type ThemePreference = "system" | "light" | "dark";

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ borderBottom: "1px solid var(--border)", paddingBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, letterSpacing: "-0.02em" }}>{title}</h2>
        {description && <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--fg-muted)" }}>{description}</p>}
      </div>
      {children}
    </section>
  );
}

function Row({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {label && <span style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--fg-subtle)" }}>{label}</span>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>{children}</div>
    </div>
  );
}

function Swatch({ token, label, hex }: { token: string; label: string; hex: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 96 }}>
      <div style={{
        height: 52,
        borderRadius: "var(--r-md)",
        background: `var(${token})`,
        border: "1px solid var(--border)"
      }} />
      <div>
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--fg)", fontFamily: "var(--font-mono)" }}>{label}</div>
        <div style={{ fontSize: 10, color: "var(--fg-subtle)", fontFamily: "var(--font-mono)" }}>{token}</div>
        <div style={{ fontSize: 10, color: "var(--fg-subtle)", fontFamily: "var(--font-mono)" }}>{hex}</div>
      </div>
    </div>
  );
}

function RadiusSample({ token, px }: { token: string; px: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "center" }}>
      <div style={{
        width: 52,
        height: 52,
        border: "1px solid var(--border-raised)",
        background: "var(--bg-overlay)",
        borderRadius: `var(${token})`
      }} />
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--fg)" }}>{px}</div>
        <div style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--fg-subtle)" }}>{token}</div>
      </div>
    </div>
  );
}

function SpacingSample({ value, label }: { value: number; label: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-start" }}>
      <div style={{
        width: value,
        height: 20,
        background: "var(--accent-dim)",
        border: "1px solid var(--accent)",
        borderRadius: 2,
        minWidth: 2
      }} />
      <div>
        <div style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--fg)" }}>{label}</div>
        <div style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--fg-subtle)" }}>{value}px</div>
      </div>
    </div>
  );
}

function TypeSample({ size, weight, label, mono }: { size: number; weight: number; label: string; mono?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 20, padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
      <span style={{ minWidth: 140, fontSize: 11, color: "var(--fg-subtle)", fontFamily: "var(--font-mono)" }}>{label}</span>
      <span style={{ fontSize: size, fontWeight: weight, fontFamily: mono ? "var(--font-mono)" : "var(--font-sans)", letterSpacing: size >= 20 ? "-0.02em" : undefined }}>
        {mono ? "$ npm run dev" : "The quick brown fox jumps"}
      </span>
    </div>
  );
}

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: "var(--r-lg)", background: "var(--bg-raised)", overflow: "hidden", ...style }}>
      {children}
    </div>
  );
}

function CardBody({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div style={{ padding: "16px 20px", ...style }}>{children}</div>;
}

/* ── Static mock pixel grid ───────────────────────────────────────────────── */
function MockLogoPixels() {
  const pixels = new Uint8Array(96 * 16);
  // Draw "PINE64" in pixels roughly
  for (let i = 0; i < pixels.length; i++) {
    const x = i % 96;
    const y = Math.floor(i / 96);
    if (y >= 3 && y <= 12 && x >= 8 && x <= 88) {
      if ((x + y) % 6 < 3) pixels[i] = 1;
    }
  }
  return (
    <span style={{
      display: "grid",
      gridTemplateColumns: "repeat(96, 1fr)",
      gridTemplateRows: "repeat(16, 1fr)",
      width: "100%",
      height: "100%"
    }}>
      {Array.from(pixels).map((px, i) => (
        <i key={i} style={{ display: "block", background: px ? "#e8e8e8" : "#050505" }} />
      ))}
    </span>
  );
}

/* ── Style Guide Page ─────────────────────────────────────────────────────── */

export default function StyleGuidePage() {
  const [theme, setTheme] = useState<ThemePreference>("system");
  const [safetyValues, setSafetyValues] = useState([false, true, false]);

  useEffect(() => {
    const stored = window.localStorage.getItem("pinecil-theme");
    if (stored === "system" || stored === "light" || stored === "dark") setTheme(stored);
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved = theme === "system" ? (media.matches ? "dark" : "light") : theme;
      document.documentElement.dataset.theme = resolved;
      document.documentElement.style.colorScheme = resolved;
      window.localStorage.setItem("pinecil-theme", theme);
    };
    apply();
    if (theme !== "system") return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--fg)", fontFamily: "var(--font-sans)" }}>

      {/* Header */}
      <header style={{
        position: "sticky",
        top: 0,
        zIndex: 10,
        borderBottom: "1px solid var(--border)",
        background: "var(--bg)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 32px",
        height: 56
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Pine64Logo size={18} />
          <span style={{ fontSize: 13, fontWeight: 600 }}>Pinecil Web Flash</span>
          <span style={{ fontSize: 13, color: "var(--fg-subtle)", marginLeft: 4 }}>/ Style Guide</span>
        </div>
        <div className="theme-switch" aria-label="Select display theme">
          {([
            { value: "system", icon: Monitor, label: "System" },
            { value: "light",  icon: Sun,     label: "Light"  },
            { value: "dark",   icon: Moon,    label: "Dark"   }
          ] as const).map(({ value, icon: Icon, label }) => (
            <button
              key={value}
              aria-label={label}
              aria-pressed={theme === value}
              onClick={() => setTheme(value)}
              title={label}
              type="button"
            >
              <Icon size={13} />
            </button>
          ))}
        </div>
      </header>

      <main style={{ maxWidth: 900, margin: "0 auto", padding: "40px 32px 80px", display: "flex", flexDirection: "column", gap: 56 }}>

        {/* ── Brand ──────────────────────────────────────────────────────── */}
        <Section title="Brand" description="Extracted Pine64 pinecone mark used across the application.">
          <Row>
            {[12, 16, 20, 28, 40].map((size) => (
              <div key={size} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
                <div style={{
                  width: size * 2.2,
                  height: size * 2.2,
                  display: "grid",
                  placeItems: "center",
                  border: "1px solid var(--border-raised)",
                  borderRadius: "var(--r-sm)",
                  background: "var(--bg-raised)"
                }}>
                  <Pine64Logo size={size} />
                </div>
                <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--fg-subtle)" }}>{size}px</span>
              </div>
            ))}
          </Row>
          <Row label="With brand text">
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", border: "1px solid var(--border)", borderRadius: "var(--r-md)", background: "var(--bg-raised)" }}>
              <div style={{ width: 30, height: 30, display: "grid", placeItems: "center", border: "1px solid var(--border-raised)", borderRadius: "var(--r-sm)", background: "var(--bg-raised)" }}>
                <Pine64Logo size={16} />
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.2 }}>Pinecil Web Flash</div>
                <div style={{ fontSize: 11, color: "var(--fg-subtle)" }}>IronOS · firmware · Bluetooth</div>
              </div>
            </div>
          </Row>
        </Section>

        {/* ── Colors ─────────────────────────────────────────────────────── */}
        <Section title="Colors" description="All CSS custom property tokens. Values shown are for the active theme.">

          <Row label="Surfaces">
            <Swatch token="--bg"         label="bg"         hex="#0a0a0a / #ffffff" />
            <Swatch token="--bg-raised"  label="bg-raised"  hex="#111111 / #fafafa" />
            <Swatch token="--bg-overlay" label="bg-overlay" hex="#1a1a1a / #f4f4f5" />
          </Row>

          <Row label="Foreground">
            <Swatch token="--fg"         label="fg"        hex="#ededed / #0a0a0a" />
            <Swatch token="--fg-muted"   label="fg-muted"  hex="#a1a1a1 / #737373" />
            <Swatch token="--fg-subtle"  label="fg-subtle" hex="#666666 / #a1a1a1" />
          </Row>

          <Row label="Borders">
            <Swatch token="--border"        label="border"        hex="#1f1f1f / #e4e4e7" />
            <Swatch token="--border-raised" label="border-raised" hex="#2e2e2e / #d4d4d8" />
          </Row>

          <Row label="Accent — Pine64 Teal">
            <Swatch token="--accent"     label="accent"     hex="#14b8a6 / #0f766e" />
            <Swatch token="--accent-dim" label="accent-dim" hex="rgba teal 14%" />
          </Row>

          <Row label="Status">
            <Swatch token="--success"     label="success"     hex="#22c55e / #16a34a" />
            <Swatch token="--success-dim" label="success-dim" hex="rgba green 12%" />
            <Swatch token="--warning"     label="warning"     hex="#f59e0b / #d97706" />
            <Swatch token="--warning-dim" label="warning-dim" hex="rgba amber 12%" />
            <Swatch token="--danger"      label="danger"      hex="#ef4444 / #dc2626" />
            <Swatch token="--danger-dim"  label="danger-dim"  hex="rgba red 12%" />
            <Swatch token="--info"        label="info"        hex="#60a5fa / #2563eb" />
            <Swatch token="--info-dim"    label="info-dim"    hex="rgba blue 12%" />
          </Row>
        </Section>

        {/* ── Typography ─────────────────────────────────────────────────── */}
        <Section title="Typography" description="Geist Sans for UI text, Geist Mono for code, hashes, telemetry, and file names.">
          <Card>
            <CardBody style={{ padding: "4px 20px" }}>
              <TypeSample size={28} weight={700} label="28 / 700" />
              <TypeSample size={20} weight={600} label="20 / 600" />
              <TypeSample size={16} weight={600} label="16 / 600" />
              <TypeSample size={14} weight={500} label="14 / 500" />
              <TypeSample size={13} weight={400} label="13 / 400 · body" />
              <TypeSample size={12} weight={400} label="12 / 400 · small" />
              <TypeSample size={11} weight={500} label="11 / 500 · label" />
            </CardBody>
          </Card>
          <Card>
            <CardBody style={{ padding: "4px 20px" }}>
              <TypeSample size={14} weight={500} label="14 / mono" mono />
              <TypeSample size={12} weight={400} label="12 / mono" mono />
              <TypeSample size={11} weight={400} label="11 / mono · log" mono />
            </CardBody>
          </Card>
        </Section>

        {/* ── Spacing ────────────────────────────────────────────────────── */}
        <Section title="Spacing" description="Base-4 spacing scale used for padding, gap, and margins.">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 20, alignItems: "flex-end" }}>
            {[4, 8, 12, 16, 20, 24, 32, 40, 48, 64].map((v) => (
              <SpacingSample key={v} value={v} label={`${v}px`} />
            ))}
          </div>
        </Section>

        {/* ── Radii ──────────────────────────────────────────────────────── */}
        <Section title="Border Radii" description="Consistent radius scale applied across all surfaces and components.">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 24 }}>
            <RadiusSample token="--r-xs"   px="4px" />
            <RadiusSample token="--r-sm"   px="6px" />
            <RadiusSample token="--r-md"   px="8px" />
            <RadiusSample token="--r-lg"   px="10px" />
            <RadiusSample token="--r-xl"   px="12px" />
            <RadiusSample token="--r-full" px="9999px" />
          </div>
        </Section>

        {/* ── Buttons ────────────────────────────────────────────────────── */}
        <Section title="Buttons" description="Four variants, two sizes, and disabled states.">
          <Row label="Variants">
            <button className="btn btn-primary" type="button"><Zap size={14} /> Primary</button>
            <button className="btn" type="button">Default</button>
            <button className="btn btn-ghost" type="button">Ghost</button>
          </Row>
          <Row label="Sizes">
            <button className="btn btn-primary" type="button"><Zap size={14} /> Flash Firmware</button>
            <button className="btn btn-primary btn-sm" type="button"><Zap size={12} /> Flash</button>
          </Row>
          <Row label="States">
            <button className="btn btn-primary" disabled type="button"><Loader2 className="spin" size={14} /> Flashing…</button>
            <button className="btn" disabled type="button">Disabled</button>
            <button className="btn btn-ghost" disabled type="button">Disabled ghost</button>
          </Row>
          <Row label="With icons">
            <button className="btn" type="button"><Plug size={14} /> Connect Pinecil</button>
            <button className="btn btn-sm" type="button"><Upload size={12} /> Choose .dfu</button>
          </Row>
        </Section>

        {/* ── Chips ──────────────────────────────────────────────────────── */}
        <Section title="Status Chips" description="Pill badges used for connection state and browser capability indicators.">
          <Row label="Tones">
            <StatusChip label="Connected"  tone="green" />
            <StatusChip label="Flash mode" tone="amber" />
            <StatusChip label="Error"      tone="red"   />
            <StatusChip label="No device"  tone="gray"  />
          </Row>
          <Row label="Connection examples">
            <StatusChip label="USB connected" tone="green" />
            <StatusChip label="Bluetooth connected" tone="green" />
            <StatusChip label="Normal mode" tone="green" />
            <StatusChip label="USB disconnected" tone="gray" />
          </Row>
        </Section>

        {/* ── Form Controls ──────────────────────────────────────────────── */}
        <Section title="Form Controls" description="Inputs, selects, and other interactive form elements.">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div className="field">
              <label className="field-label" htmlFor="sg-text">Text input</label>
              <input className="input" id="sg-text" type="text" placeholder="e.g. PC2V2-DEMO" />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="sg-select">Select</label>
              <select className="select" id="sg-select" defaultValue="stable">
                <option value="stable">Stable</option>
                <option value="prerelease">Beta / prerelease</option>
              </select>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="sg-number">Number input</label>
              <input className="input" id="sg-number" type="number" defaultValue={128} min={16} max={240} style={{ fontFamily: "var(--font-mono)" }} />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="sg-disabled">Disabled state</label>
              <input className="input" id="sg-disabled" type="text" placeholder="Not available" disabled />
            </div>
          </div>
          <Row label="Range slider">
            <div style={{ width: 280 }}>
              <input type="range" min={16} max={240} defaultValue={128} />
            </div>
          </Row>
          <Row label="Checkbox">
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
              <input type="checkbox" defaultChecked /> Flash mode is active
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
              <input type="checkbox" /> The DC barrel jack is disconnected
            </label>
          </Row>
        </Section>

        {/* ── Cards ──────────────────────────────────────────────────────── */}
        <Section title="Cards" description="Section cards with optional stacked bodies separated by hairline dividers.">
          <Card style={{ maxWidth: 480 }}>
            <CardBody>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Single body card</div>
              <div style={{ fontSize: 13, color: "var(--fg-muted)" }}>Used for grouped form fields like release channel, release, and language selectors.</div>
            </CardBody>
          </Card>
          <Card style={{ maxWidth: 480 }}>
            <CardBody>
              <div style={{ fontSize: 13, fontWeight: 600 }}>First body</div>
              <div style={{ fontSize: 13, color: "var(--fg-muted)", marginTop: 4 }}>Content area — forms, controls.</div>
            </CardBody>
            <div style={{ padding: "12px 20px", borderTop: "1px solid var(--border)", fontSize: 13, color: "var(--fg-muted)" }}>
              Second body — secondary actions or metadata.
            </div>
          </Card>
        </Section>

        {/* ── Info Rows ──────────────────────────────────────────────────── */}
        <Section title="Info Rows" description="Key-value metadata table used in all three panels.">
          <div style={{ maxWidth: 560 }}>
            <InfoRows rows={[
              ["File",         "Pinecilv2_EN.bin"],
              ["Release date", "2025-08-31"],
              ["SHA-256",      "a3f8c1d2e4b5…"],
              ["Target",       "Pinecil V2"]
            ]} />
          </div>
        </Section>

        {/* ── Callouts ───────────────────────────────────────────────────── */}
        <Section title="Callouts" description="Contextual banners for warnings, confirmations, and informational notices.">
          <div className="callout callout-warning" style={{ maxWidth: 560 }}>
            <AlertTriangle size={15} />
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
              <input type="checkbox" />
              I understand this is prerelease firmware and may contain regressions.
            </label>
          </div>
          <div className="callout callout-warning" style={{ maxWidth: 560 }}>
            <AlertTriangle size={15} />
            <p style={{ margin: 0, fontSize: 13 }}>Bluetooth reports read-only mode. Runtime writes and Save are disabled.</p>
          </div>
          <div className="callout callout-info" style={{ maxWidth: 560 }}>
            <Info size={15} />
            <p style={{ margin: 0, fontSize: 13 }}>Chromium-based browser required for WebUSB, Web Serial, and Web Bluetooth.</p>
          </div>
        </Section>

        {/* ── Safety Checklist ───────────────────────────────────────────── */}
        <Section title="Safety Checklist" description="Gate that must be cleared before flashing. Used in Firmware and Boot Logo panels.">
          <div style={{ maxWidth: 680 }}>
            <SafetyChecklist disabled={false} onChange={setSafetyValues} values={safetyValues}>
              <label className="safety-item safety-item-warning">
                <input type="checkbox" />
                <AlertTriangle size={15} />
                <span>I understand this is prerelease firmware and may contain regressions.</span>
              </label>
            </SafetyChecklist>
          </div>
          <div style={{ maxWidth: 680 }}>
            <SafetyChecklist disabled={true} onChange={() => {}} values={[false, false, false]} />
          </div>
          <Row>
            <span style={{ fontSize: 12, color: "var(--fg-subtle)" }}>Top: interactive (one item checked) · Bottom: disabled state</span>
          </Row>
        </Section>

        {/* ── Empty Notice ───────────────────────────────────────────────── */}
        <Section title="Empty / Connect Notice" description="Shown when a panel requires a connected device.">
          <div style={{ maxWidth: 560 }}>
            <EmptyConnectNotice />
          </div>
        </Section>

        {/* ── Iron Schematic ─────────────────────────────────────────────── */}
        <Section title="Iron Schematic" description="Inline SVG representation of the Pinecil in three connection states.">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, maxWidth: 680 }}>
            {[
              { label: "Disconnected", connected: false, flashing: false },
              { label: "Connected (V2, USB)", connected: true, flashing: false, transport: "webserial-blisp" as const, model: "v2" as const },
              { label: "Flashing", connected: true, flashing: true, transport: "webserial-blisp" as const, model: "v2" as const }
            ].map(({ label, connected, flashing, transport, model }) => (
              <div key={label} style={{ border: "1px solid var(--border)", borderRadius: "var(--r-md)", padding: "16px 12px 12px", background: "var(--bg-raised)", display: "flex", flexDirection: "column", gap: 12 }}>
                <IronSchematic connected={connected} flashing={flashing} model={model} transport={transport} />
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 12, fontWeight: 500, color: "var(--fg)" }}>{label}</div>
                  <div style={{ fontSize: 11, color: "var(--fg-subtle)", fontFamily: "var(--font-mono)", marginTop: 2 }}>
                    {connected ? (flashing ? "tip pulses" : "tip + dot teal") : "all muted"}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Section>

        {/* ── Toast ──────────────────────────────────────────────────────── */}
        <Section title="Toast Notifications" description="Transient alerts surfaced from OK / WARN / ERROR log events. Auto-dismiss 4 s; ERROR persists.">
          <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 400 }}>
            <div className="toast" data-level="OK" style={{ position: "static", animation: "none" }}>
              <span className="toast-icon" data-level="OK"><CheckCircle2 size={15} /></span>
              <span className="toast-msg">v2.23 Pinecilv2_EN.bin validated (256 KB, SHA-256 a3f8c1d2…).</span>
            </div>
            <div className="toast" data-level="WARN" style={{ position: "static", animation: "none" }}>
              <span className="toast-icon" data-level="WARN"><AlertTriangle size={15} /></span>
              <span className="toast-msg">Release fetch failed; using local sample catalog.</span>
            </div>
            <div className="toast" data-level="ERROR" style={{ position: "static", animation: "none" }}>
              <span className="toast-icon" data-level="ERROR"><XCircle size={15} /></span>
              <span className="toast-msg">DFU suffix CRC does not match. Check the file and try again.</span>
            </div>
          </div>
        </Section>

        {/* ── Activity Log ───────────────────────────────────────────────── */}
        <Section title="Activity Log" description="Collapsible footer bar with progress track and expandable log list.">
          <Card>
            {/* Bar */}
            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "0 16px", height: 44, borderBottom: "1px solid var(--border)" }}>
              <span style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--fg-subtle)", display: "flex", alignItems: "center", gap: 6 }}>
                ↓ Activity
              </span>
              <div style={{ flex: 1, height: 3, borderRadius: 9999, background: "var(--border-raised)", overflow: "hidden" }}>
                <div style={{ width: "65%", height: "100%", background: "var(--accent)", borderRadius: 9999, transition: "width 200ms" }} />
              </div>
              <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--fg-muted)" }}>65%</span>
              <span style={{ fontSize: 11, color: "var(--fg-muted)" }}>Writing</span>
              <button className="btn btn-ghost btn-sm" type="button">Clear</button>
            </div>
            {/* Expanded log */}
            <div style={{ display: "grid", gridTemplateColumns: "280px 1fr" }}>
              <div style={{ padding: "14px 16px", borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 8 }}>
                {[["Target", "Pinecil V2 demo"], ["File", "Pinecilv2_EN.bin"], ["Status", "65% · Writing sector 14/22"]].map(([k, v]) => (
                  <div key={k} style={{ display: "grid", gridTemplateColumns: "60px 1fr", gap: 8, fontSize: 12 }}>
                    <dt style={{ color: "var(--fg-subtle)" }}>{k}</dt>
                    <dd style={{ margin: 0, fontFamily: "var(--font-mono)", color: "var(--fg-muted)", fontSize: 11, wordBreak: "break-all" }}>{v}</dd>
                  </div>
                ))}
              </div>
              <div style={{ padding: 10, fontFamily: "var(--font-mono)", fontSize: 11.5 }}>
                {[
                  { time: "14:32:01", level: "INFO", msg: "Writing sector 14 of 22…" },
                  { time: "14:31:58", level: "OK",   msg: "Pinecilv2_EN.bin validated (256 KB)." },
                  { time: "14:31:55", level: "INFO", msg: "Preparing, validating, and hashing file." },
                  { time: "14:31:50", level: "OK",   msg: "Loaded 32 language entries for V2." },
                  { time: "14:31:48", level: "WARN", msg: "Using local sample catalog." }
                ].map(({ time, level, msg }) => (
                  <p key={time} style={{ display: "grid", gridTemplateColumns: "60px 46px 1fr", gap: 6, margin: "0 0 6px", alignItems: "baseline", lineHeight: 1.6 }}>
                    <span style={{ color: "var(--fg-subtle)" }}>{time}</span>
                    <b className="log-level" data-level={level}>{level}</b>
                    <span style={{ color: "var(--fg-muted)", wordBreak: "break-word" }}>{msg}</span>
                  </p>
                ))}
              </div>
            </div>
          </Card>
        </Section>

        {/* ── Drop Zone ──────────────────────────────────────────────────── */}
        <Section title="Drop Zone" description="File drag-and-drop target used in Boot Logo for image input.">
          <div style={{ maxWidth: 340 }}>
            <label className="drop-zone" style={{ pointerEvents: "none" }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" />
              </svg>
              <strong>Drop an image or click to browse</strong>
              <span>PNG, JPEG, WebP, BMP · GIF/APNG uses first frame</span>
            </label>
          </div>
        </Section>

        {/* ── Logo Screen ────────────────────────────────────────────────── */}
        <Section title="Logo Screen" description="96×16 monochrome pixel canvas used in the Boot Logo preview.">
          <div style={{ maxWidth: 480 }}>
            <div className="logo-screen">
              <MockLogoPixels />
            </div>
            <p style={{ fontSize: 12, color: "var(--fg-subtle)", marginTop: 8 }}>96 columns × 16 rows · each pixel maps to one bit in the .dfu file payload</p>
          </div>
          <div style={{ maxWidth: 480 }}>
            <div className="logo-screen"><span>PINE64</span></div>
            <p style={{ fontSize: 12, color: "var(--fg-subtle)", marginTop: 8 }}>Placeholder state (no image loaded)</p>
          </div>
        </Section>

      </main>
    </div>
  );
}
