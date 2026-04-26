"use client";

import { useMemo } from "react";
import { Activity, AlertTriangle, Check, Save } from "lucide-react";
import type { BleSettingDraft, BleSnapshot } from "@/lib/types";

type TelemetrySample = {
  at: number;
  telemetry: Record<string, number>;
};

type TelemetryItem = {
  key: string;
  label: string;
  graphClass: string;
  unit: string;
  format(value: number): string;
  formatAxis(value: number): string;
  graphValue?(value: number): number;
};

const telemetryItems: TelemetryItem[] = [
  { key: "tipTempC",       label: "Tip temp",  graphClass: "tip",      unit: "°C", format: (v) => `${Math.round(v)} °C`,       formatAxis: (v) => `${Math.round(v)}°` },
  { key: "setPointC",      label: "Set point", graphClass: "setpoint", unit: "°C", format: (v) => `${Math.round(v)} °C`,       formatAxis: (v) => `${Math.round(v)}°` },
  { key: "dcInputMv",      label: "DC input",  graphClass: "input",    unit: "V",  format: (v) => `${(v / 1000).toFixed(2)} V`, formatAxis: (v) => `${v.toFixed(1)} V`, graphValue: (v) => v / 1000 },
  { key: "estimatedWatts", label: "Power",     graphClass: "power",    unit: "W",  format: (v) => `${v} W`,                    formatAxis: (v) => `${Math.round(v)} W` }
];

const temperatureItems = telemetryItems.filter((item) => item.key === "tipTempC" || item.key === "setPointC");
const powerItems = telemetryItems.filter((item) => item.key === "dcInputMv" || item.key === "estimatedWatts");

function graphValueFor(item: TelemetryItem, value: number) {
  return item.graphValue ? item.graphValue(value) : value;
}

function valueRangeFor(samples: TelemetrySample[], items: TelemetryItem[]) {
  const values = samples.flatMap((sample) =>
    items
      .map((item) => {
        const value = sample.telemetry[item.key];
        return Number.isFinite(value) ? graphValueFor(item, value) : undefined;
      })
      .filter((value): value is number => Number.isFinite(value))
  );
  if (!values.length) return undefined;
  return { min: Math.min(...values), max: Math.max(...values) };
}

function paddedRangeFor(range?: { min: number; max: number }) {
  if (!range) return undefined;
  const valueRange = range.max - range.min;
  if (valueRange === 0) {
    const padding = Math.max(Math.abs(range.max) * 0.04, 1);
    return { min: range.min - padding, max: range.max + padding };
  }
  return { min: range.min - valueRange * 0.08, max: range.max + valueRange * 0.08 };
}

function buildAxisTicks(range: { min: number; max: number } | undefined, format: (value: number) => string) {
  const padded = paddedRangeFor(range);
  if (!padded) return [];
  const span = padded.max - padded.min;
  return [25, 50, 75].map((position) => {
    const value = padded.max - span * (position / 100);
    return { label: format(value), position };
  });
}

function formatTimeTick(at: number) {
  return new Date(at).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  });
}

function buildTimeTicks(samples: TelemetrySample[]) {
  if (!samples.length) return [];
  if (samples.length === 1) return [{ label: formatTimeTick(samples[0].at), position: 50 }];
  const minTime = samples[0].at;
  const maxTime = samples[samples.length - 1].at;
  return [
    { at: minTime, position: 0 },
    { at: minTime + (maxTime - minTime) / 2, position: 50 },
    { at: maxTime, position: 100 }
  ].map((tick) => ({ label: formatTimeTick(tick.at), position: tick.position }));
}

function smoothPathFor(points: Array<{ x: number; y: number }>) {
  if (points.length < 2) return "";
  const point = (value: number) => Math.min(100, Math.max(0, value));
  if (points.length === 2) {
    return `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)} L ${points[1].x.toFixed(2)} ${points[1].y.toFixed(2)}`;
  }

  const commands = [`M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`];
  for (let index = 0; index < points.length - 1; index += 1) {
    const previous = points[index - 1] ?? points[index];
    const current = points[index];
    const next = points[index + 1];
    const after = points[index + 2] ?? next;
    const controlOne = {
      x: current.x + (next.x - previous.x) / 6,
      y: current.y + (next.y - previous.y) / 6
    };
    const controlTwo = {
      x: next.x - (after.x - current.x) / 6,
      y: next.y - (after.y - current.y) / 6
    };
    commands.push(
      `C ${point(controlOne.x).toFixed(2)} ${point(controlOne.y).toFixed(2)}, ${point(controlTwo.x).toFixed(2)} ${point(controlTwo.y).toFixed(2)}, ${next.x.toFixed(2)} ${next.y.toFixed(2)}`
    );
  }
  return commands.join(" ");
}

function buildSeriesPath(samples: TelemetrySample[], item: TelemetryItem, range?: { min: number; max: number }) {
  const values = samples
    .map((sample) => {
      const value = sample.telemetry[item.key];
      return { at: sample.at, value: Number.isFinite(value) ? graphValueFor(item, value) : undefined };
    })
    .filter((sample): sample is { at: number; value: number } => Number.isFinite(sample.value));
  if (values.length < 2) return "";

  const minTime = values[0].at;
  const maxTime = values[values.length - 1].at;
  const minValue = range?.min ?? Math.min(...values.map((sample) => sample.value));
  const maxValue = range?.max ?? Math.max(...values.map((sample) => sample.value));
  const timeRange = Math.max(1, maxTime - minTime);
  const valueRange = { min: minValue, max: maxValue };
  const padded = paddedRangeFor(valueRange) ?? valueRange;
  const paddedRange = Math.max(1, padded.max - padded.min);

  const points = values
    .map((sample) => {
      const x = ((sample.at - minTime) / timeRange) * 100;
      const y = 100 - ((sample.value - padded.min) / paddedRange) * 100;
      return { x, y: Math.min(100, Math.max(0, y)) };
    });
  return smoothPathFor(points);
}

function TelemetryGraph({
  ariaLabel,
  items,
  samples,
  sharedRange,
  title,
  yAxisLabel
}: {
  ariaLabel: string;
  items: TelemetryItem[];
  samples: TelemetrySample[];
  sharedRange?: boolean;
  title: string;
  yAxisLabel: string;
}) {
  const sharedValueRange = useMemo(() => (sharedRange ? valueRangeFor(samples, items) : undefined), [items, samples, sharedRange]);
  const itemRanges = useMemo(() => items.map((item) => valueRangeFor(samples, [item])), [items, samples]);
  const series = useMemo(
    () => items.map((item, index) => ({ ...item, path: buildSeriesPath(samples, item, sharedValueRange ?? itemRanges[index]) })),
    [items, itemRanges, samples, sharedValueRange]
  );
  const timeTicks = useMemo(() => buildTimeTicks(samples), [samples]);
  const leftAxis = sharedRange
    ? { unit: yAxisLabel, ticks: buildAxisTicks(sharedValueRange, items[0]?.formatAxis ?? ((value) => `${value}`)) }
    : { unit: items[0]?.unit ?? yAxisLabel, ticks: buildAxisTicks(itemRanges[0], items[0]?.formatAxis ?? ((value) => `${value}`)) };
  const rightAxis = !sharedRange && items[1]
    ? { unit: items[1].unit, ticks: buildAxisTicks(itemRanges[1], items[1].formatAxis) }
    : undefined;

  return (
    <div className="telemetry-chart section-card">
      <div className="telemetry-chart-header">
        <span className="telemetry-chart-title">
          <Activity size={14} />
          {title}
        </span>
      </div>
      <div className="telemetry-chart-frame" data-has-right-axis={rightAxis ? "true" : "false"}>
        <div className="telemetry-chart-axis-scale telemetry-chart-axis-scale-left" aria-hidden="true">
          <span className="telemetry-chart-axis-unit">{leftAxis.unit}</span>
          {leftAxis.ticks.map((tick) => (
            <span className="telemetry-chart-axis-tick" key={`${tick.position}-${tick.label}`} style={{ top: `${tick.position}%` }}>
              {tick.label}
            </span>
          ))}
        </div>
        <div className="telemetry-chart-plot" aria-label={ariaLabel} role="img">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none">
            <path className="telemetry-chart-grid" d="M 0 25 H 100 M 0 50 H 100 M 0 75 H 100" />
            {series.map((item) =>
              item.path ? (
                <path className={`telemetry-chart-line telemetry-chart-line-${item.graphClass}`} d={item.path} key={item.key} />
              ) : null
            )}
          </svg>
        </div>
        {rightAxis ? (
          <div className="telemetry-chart-axis-scale telemetry-chart-axis-scale-right" aria-hidden="true">
            <span className="telemetry-chart-axis-unit">{rightAxis.unit}</span>
            {rightAxis.ticks.map((tick) => (
              <span className="telemetry-chart-axis-tick" key={`${tick.position}-${tick.label}`} style={{ top: `${tick.position}%` }}>
                {tick.label}
              </span>
            ))}
          </div>
        ) : null}
        <div className="telemetry-chart-axis telemetry-chart-axis-x" aria-hidden="true">
          {timeTicks.map((tick) => (
            <span
              className="telemetry-chart-axis-x-tick"
              data-edge={tick.position === 0 ? "start" : tick.position === 100 ? "end" : undefined}
              key={`${tick.position}-${tick.label}`}
              style={{ left: `${tick.position}%` }}
            >
              {tick.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

export function BlePanel({
  snapshot,
  telemetryHistory
}: {
  snapshot?: BleSnapshot;
  telemetryHistory: TelemetrySample[];
}) {
  return (
    <div className="panel-section">
      <div className="section-heading">
        <div className="section-heading-text">
          <h2>Telemetry</h2>
          <p>Live Pinecil V2 telemetry requires normal powered operation, not flash mode.</p>
        </div>
      </div>

      {snapshot?.readOnly ? (
        <div className="callout callout-warning">
          <AlertTriangle size={15} />
          <p>Bluetooth reports read-only mode. Runtime writes and Save are disabled.</p>
        </div>
      ) : null}

      <div className="telemetry-grid">
        {telemetryItems.map(({ graphClass, key, label, format }) => {
          const value = snapshot?.telemetry[key];
          return (
            <div className={`telemetry-kpi telemetry-kpi-${graphClass}`} key={key}>
              <span className="telemetry-kpi-label">
                <span className={`telemetry-kpi-swatch telemetry-kpi-swatch-${graphClass}`} />
                {label}
              </span>
              <span className="telemetry-kpi-value">{value === undefined ? "—" : format(value)}</span>
            </div>
          );
        })}
      </div>

      <TelemetryGraph
        ariaLabel="Live Bluetooth temperature graph"
        items={temperatureItems}
        samples={telemetryHistory}
        sharedRange
        title="Temperature"
        yAxisLabel="°C"
      />

      <TelemetryGraph
        ariaLabel="Live Bluetooth power and input graph"
        items={powerItems}
        samples={telemetryHistory}
        title="Power and input"
        yAxisLabel="V / W"
      />
    </div>
  );
}

export function BleSettingsPanel({
  busy,
  drafts,
  onApply,
  onDraftChange,
  onSave,
  snapshot
}: {
  busy: boolean;
  drafts: BleSettingDraft[];
  onApply(): void;
  onDraftChange(setting: BleSettingDraft, value: number): void;
  onSave(): void;
  snapshot?: BleSnapshot;
}) {
  const dirtyCount = drafts.filter((d) => d.dirty).length;

  return (
    <div className="panel-section">
      <div className="section-heading">
        <div className="section-heading-text">
          <h2>Settings</h2>
          <p>Stage runtime setting changes, apply them to the iron, then save to flash when they should survive reboot.</p>
        </div>
      </div>

      {snapshot?.readOnly ? (
        <div className="callout callout-warning">
          <AlertTriangle size={15} />
          <p>Bluetooth reports read-only mode. Runtime writes and Save are disabled.</p>
        </div>
      ) : null}

      <div className="section-card ble-settings-panel">
        <div className="settings-table-wrap">
          <table className="settings-table">
            <thead>
              <tr>
                <th>Setting</th>
                <th>Value</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {drafts.map((setting) => {
                const writable = Boolean(snapshot && !snapshot.readOnly && setting.writable && !busy);
                const segmented = setting.options && setting.options.length > 0;
                return (
                  <tr data-dirty={setting.dirty ? "true" : "false"} key={setting.id}>
                    <td style={{ fontWeight: 500, color: "var(--fg)" }}>{setting.name}</td>
                    <td>
                      {segmented ? (
                        <div className="segmented" role="radiogroup" aria-label={setting.name}>
                          {setting.options!.map((option) => (
                            <button
                              aria-pressed={setting.draftValue === option.value}
                              className="segmented-option"
                              disabled={!writable}
                              key={option.value}
                              onClick={() => onDraftChange(setting, option.value)}
                              role="radio"
                              type="button"
                            >
                              {option.label}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <span className="setting-number">
                          <input
                            className="input"
                            disabled={!writable}
                            max={setting.max}
                            min={setting.min}
                            onChange={(e) => onDraftChange(setting, Number(e.target.value))}
                            type="number"
                            value={setting.draftValue}
                          />
                          {setting.unit ? <span className="setting-unit">{setting.unit}</span> : null}
                        </span>
                      )}
                    </td>
                    <td>
                      {setting.description}
                      {!setting.writable ? " · Read-only" : setting.dirty ? " · Staged" : ""}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flash-action-bar">
        <button
          className="btn"
          disabled={busy || !snapshot || snapshot.readOnly || !dirtyCount}
          onClick={onApply}
          title="Write the staged values to the iron's runtime settings. Takes effect immediately but is lost on reboot until you Save to flash."
          type="button"
        >
          <Check size={14} />
          Apply {dirtyCount > 0 ? `(${dirtyCount})` : "changes"}
        </button>
        <button
          className="btn btn-primary"
          disabled={busy || !snapshot || snapshot.readOnly}
          onClick={onSave}
          title="Persist the current runtime settings to the iron's flash memory so they survive a reboot."
          type="button"
        >
          <Save size={14} /> Save to flash
        </button>
      </div>
    </div>
  );
}
