"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Bluetooth, Check, CircleHelp, Clock3, Gauge, Monitor, Save, Thermometer, Zap, type LucideIcon } from "lucide-react";
import { GroupedPanel } from "@/components/shared";
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
  formatInlineAxis?(value: number): string;
  axisMin?: number;
  axisStep?: number;
  graphValue?(value: number): number;
};

type SecondaryTelemetryItem = {
  key: string;
  label: string;
  description: string;
  graphClass?: string;
  format(value: number): string;
};

type SecondaryTelemetryGroup = {
  title: string;
  icon: LucideIcon;
  items: SecondaryTelemetryItem[];
};

type SettingsGroupDefinition = {
  title: string;
  icon: LucideIcon;
  ids: number[];
};

type TempUnit = "C" | "F";

const TELEMETRY_GRAPH_WINDOW_MS = 90_000;
const TELEMETRY_GRAPH_TICK_MS = 10_000;
const TELEMETRY_GRAPH_LABEL_MS = 30_000;

function celsiusToUnit(value: number, unit: TempUnit) {
  return unit === "F" ? value * 9 / 5 + 32 : value;
}

function formatTemp(value: number, unit: TempUnit) {
  return `${Math.round(celsiusToUnit(value, unit))} °${unit}`;
}

function formatTempX10(value: number, unit: TempUnit) {
  return `${celsiusToUnit(value / 10, unit).toFixed(1)} °${unit}`;
}

function formatVoltageX10(value: number) {
  return `${(value / 10).toFixed(1)} V`;
}

function formatWattsX10(value: number) {
  return `${(value / 10).toFixed(1)} W`;
}

function formatOhmsX10(value: number) {
  return `${(value / 10).toFixed(1)} ohm`;
}

function formatDuration(totalSeconds: number) {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 60) return `${seconds} s`;

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds.toString().padStart(2, "0")}s`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes.toString().padStart(2, "0")}m`;
}

function formatDeciseconds(value: number) {
  return formatDuration(value / 10);
}

function formatEnum(labels: Record<number, string>, fallback: string, value: number) {
  return labels[value] ?? fallback;
}

const powerSourceLabels: Record<number, string> = {
  0: "DC input",
  1: "QC / fallback",
  2: "PD VBUS",
  3: "USB-PD"
};

const operatingModeLabels: Record<number, string> = {
  0: "Home",
  1: "Soldering",
  3: "Sleeping",
  4: "Settings",
  5: "Debug",
  6: "Profile",
  7: "Temperature adjust",
  8: "USB-PD debug",
  9: "Thermal runaway",
  10: "Startup logo",
  11: "CJC calibration",
  12: "Startup warnings",
  13: "Ready",
  14: "Hibernating"
};

const powerSourceSummary = "Where the iron believes input power is coming from: DC input, QC / fallback, PD VBUS, or USB-PD.";
const operatingModeSummary = "The current IronOS screen or workflow state, such as Home, Soldering, Sleeping, Settings, Debug, Profile, Temperature adjust, USB-PD debug, Thermal runaway, Startup logo, CJC calibration, Startup warnings, Ready, or Hibernating.";

const settingsGroupDefinitions: SettingsGroupDefinition[] = [
  { title: "Thermal", icon: Thermometer, ids: [0, 1, 2, 15] },
  { title: "Power", icon: Zap, ids: [24, 38] },
  { title: "Display", icon: Monitor, ids: [33, 34, 35] },
  { title: "Bluetooth", icon: Bluetooth, ids: [37] }
];

function makeChartTelemetryItems(unit: TempUnit): TelemetryItem[] {
  return [
    {
      key: "tipTempC",
      label: "Tip temperature",
      graphClass: "tip",
      unit: `°${unit}`,
      format: (value) => formatTemp(value, unit),
      formatAxis: (value) => `${Math.round(value)}°`,
      formatInlineAxis: (value) => `${Math.round(value)}`,
      axisStep: 50,
      graphValue: (value) => celsiusToUnit(value, unit)
    },
    {
      key: "estimatedWatts",
      label: "Power draw",
      graphClass: "power",
      unit: "W",
      format: formatWattsX10,
      formatAxis: (value) => `${value.toFixed(1)} W`,
      formatInlineAxis: (value) => `${Math.round(value)}`,
      axisMin: 0,
      axisStep: 5,
      graphValue: (value) => value / 10
    }
  ];
}

function makeSecondaryTelemetryGroups(unit: TempUnit): SecondaryTelemetryGroup[] {
  return [
    {
      title: "Thermal",
      icon: Thermometer,
      items: [
        { key: "tipTempC", label: "Tip temperature", description: "The current calculated soldering tip temperature.", graphClass: "tip", format: (value) => formatTemp(value, unit) },
        { key: "setPointC", label: "Set point", description: "The target soldering temperature currently configured on the iron.", format: (value) => formatTemp(value, unit) },
        { key: "handleTempC", label: "Handle temperature", description: "The handle thermistor temperature. IronOS reports this as tenths of a degree Celsius.", format: (value) => formatTempX10(value, unit) },
        {
          key: "rawTip",
          label: "Tip signal",
          description: "Raw tip temperature-sense voltage after ADC conversion. IronOS reports this in microvolts.",
          format: (value) => `${value} µV`
        }
      ]
    },
    {
      title: "Power",
      icon: Zap,
      items: [
        { key: "estimatedWatts", label: "Power draw", description: "Estimated heater power draw. IronOS reports this as tenths of a watt.", graphClass: "power", format: formatWattsX10 },
        { key: "dcInputMv", label: "DC input", description: "Measured input voltage. IronOS reports this as tenths of a volt.", format: formatVoltageX10 },
        { key: "powerLevel", label: "Power level", description: "Current heater drive level as a percentage of available control range.", format: (value) => `${value}%` },
        { key: "powerSource", label: "Power source", description: powerSourceSummary, format: (value) => formatEnum(powerSourceLabels, "Unknown source", value) },
        { key: "tipResistance", label: "Tip resistance", description: "Detected or configured tip resistance. IronOS reports this as tenths of an ohm.", format: formatOhmsX10 }
      ]
    },
    {
      title: "Timing",
      icon: Clock3,
      items: [
        { key: "uptimeSeconds", label: "Uptime", description: "How long IronOS has been running since the last boot. IronOS reports this in deciseconds.", format: formatDeciseconds },
        { key: "lastMovementSeconds", label: "Last movement", description: "When movement was last detected, measured from boot time. IronOS reports this timestamp in deciseconds.", format: formatDeciseconds }
      ]
    },
    {
      title: "Sensors & State",
      icon: Gauge,
      items: [
        {
          key: "hallSensor",
          label: "Hall effect",
          description: "Optional Hall effect sensor reading. This is a unitless raw magnetic-field count; irons without the user-installed sensor may report 0 raw, which can also mean no nearby magnet.",
          format: (value) => `${value} raw`
        },
        { key: "operatingMode", label: "Operating mode", description: operatingModeSummary, format: (value) => formatEnum(operatingModeLabels, "Unknown mode", value) }
      ]
    }
  ];
}

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

function cleanAxisStepFor(span: number, baseStep: number) {
  const maxTickIntervals = 6;
  const multiplier = Math.max(1, span / (baseStep * maxTickIntervals));
  const magnitude = 10 ** Math.floor(Math.log10(multiplier));
  const normalized = multiplier / magnitude;
  const niceMultiplier = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return baseStep * niceMultiplier * magnitude;
}

function axisRangeFor(range: { min: number; max: number } | undefined, item?: TelemetryItem) {
  const padded = paddedRangeFor(range);
  if (!padded) return undefined;
  if (!item?.axisStep) return padded;

  const step = cleanAxisStepFor(Math.max(item.axisStep, padded.max - padded.min), item.axisStep);
  let min = Math.floor(padded.min / step) * step;
  const max = Math.ceil(padded.max / step) * step;
  if (item.axisMin !== undefined) min = Math.max(item.axisMin, min);

  return {
    min,
    max: max <= min ? min + step : max,
    step
  };
}

function buildAxisTicks(axisRange: ReturnType<typeof axisRangeFor>, format: (value: number) => string) {
  if (!axisRange) return [];
  const span = Math.max(1, axisRange.max - axisRange.min);

  if (!("step" in axisRange)) {
    return [25, 50, 75].map((position) => {
      const value = axisRange.max - span * (position / 100);
      return { label: format(value), position };
    });
  }

  const firstTick = Math.ceil(axisRange.min / axisRange.step) * axisRange.step;
  const ticks = [];
  for (let value = firstTick; value <= axisRange.max + axisRange.step / 1000; value += axisRange.step) {
    ticks.push({
      label: format(Math.abs(value) < axisRange.step / 1000 ? 0 : value),
      position: 100 - ((value - axisRange.min) / span) * 100
    });
  }
  return ticks.map((tick, index) => ({
    ...tick,
    label: index % 2 === 0 || index === ticks.length - 1 ? tick.label : ""
  }));
}

function formatInlineAxisTick(value: number) {
  const rounded = Math.round(value);
  if (Math.abs(value - rounded) < 0.05 || Math.abs(value) >= 100) return `${rounded}`;
  return value.toFixed(1);
}

function timeWindowFor(samples: TelemetrySample[]) {
  const latestSample = samples[samples.length - 1];
  if (!latestSample) return undefined;
  return {
    start: latestSample.at - TELEMETRY_GRAPH_WINDOW_MS,
    end: latestSample.at
  };
}

function formatRelativeTimeTick(secondsAgo: number) {
  if (secondsAgo === 0) return "now";
  if (secondsAgo % 60 === 0) return `${secondsAgo / 60}m`;
  return `${secondsAgo}s`;
}

function buildTimeTicks(timeWindow?: { start: number; end: number }) {
  if (!timeWindow) return [];
  const span = Math.max(1, timeWindow.end - timeWindow.start);
  const tickCount = Math.floor(span / TELEMETRY_GRAPH_TICK_MS);
  return Array.from({ length: tickCount + 1 }, (_, index) => {
    const elapsed = Math.min(span, index * TELEMETRY_GRAPH_TICK_MS);
    const ageMs = span - elapsed;
    const secondsAgo = Math.round(ageMs / 1000);
    const shouldLabel = ageMs === 0 || ageMs % TELEMETRY_GRAPH_LABEL_MS === 0;
    return {
      label: shouldLabel ? formatRelativeTimeTick(secondsAgo) : "",
      position: (elapsed / span) * 100
    };
  });
}

function buildChartGridPath(timeTicks: Array<{ position: number }>, yTicks: Array<{ position: number }>) {
  const horizontal = yTicks
    .filter((tick) => tick.position > 0 && tick.position < 100)
    .map((tick) => `M 0 ${tick.position.toFixed(2)} H 100`)
    .join(" ") || "M 0 25 H 100 M 0 50 H 100 M 0 75 H 100";
  const vertical = timeTicks
    .filter((tick) => tick.position > 0 && tick.position < 100)
    .map((tick) => `M ${tick.position.toFixed(2)} 0 V 100`)
    .join(" ");
  return vertical ? `${horizontal} ${vertical}` : horizontal;
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

function buildSeriesPath(samples: TelemetrySample[], item: TelemetryItem, timeWindow?: { start: number; end: number }, range?: { min: number; max: number }) {
  if (!timeWindow) return "";
  const values = samples
    .map((sample) => {
      const value = sample.telemetry[item.key];
      return { at: sample.at, value: Number.isFinite(value) ? graphValueFor(item, value) : undefined };
    })
    .filter((sample) => sample.at >= timeWindow.start && sample.at <= timeWindow.end)
    .filter((sample): sample is { at: number; value: number } => Number.isFinite(sample.value));
  if (values.length < 2) return "";

  const minValue = range?.min ?? Math.min(...values.map((sample) => sample.value));
  const maxValue = range?.max ?? Math.max(...values.map((sample) => sample.value));
  const timeRange = Math.max(1, timeWindow.end - timeWindow.start);
  const dataRange = { min: minValue, max: maxValue };
  const valueRange = range ?? paddedRangeFor(dataRange) ?? dataRange;
  const paddedRange = Math.max(1, valueRange.max - valueRange.min);

  const points = values
    .map((sample) => {
      const x = ((sample.at - timeWindow.start) / timeRange) * 100;
      const y = 100 - ((sample.value - valueRange.min) / paddedRange) * 100;
      return { x, y: Math.min(100, Math.max(0, y)) };
    });
  return smoothPathFor(points);
}

function TelemetryGraph({
  ariaLabel,
  inline = false,
  items,
  samples,
  sharedRange,
  title,
  yAxisLabel
}: {
  ariaLabel: string;
  inline?: boolean;
  items: TelemetryItem[];
  samples: TelemetrySample[];
  sharedRange?: boolean;
  title: string;
  yAxisLabel: string;
}) {
  const timeWindow = useMemo(() => timeWindowFor(samples), [samples]);
  const visibleSamples = useMemo(
    () => timeWindow ? samples.filter((sample) => sample.at >= timeWindow.start && sample.at <= timeWindow.end) : [],
    [samples, timeWindow]
  );
  const sharedValueRange = useMemo(() => (sharedRange ? valueRangeFor(visibleSamples, items) : undefined), [items, sharedRange, visibleSamples]);
  const itemRanges = useMemo(() => items.map((item) => valueRangeFor(visibleSamples, [item])), [items, visibleSamples]);
  const timeTicks = useMemo(() => buildTimeTicks(timeWindow), [timeWindow]);
  const leftAxisFormat = inline ? items[0]?.formatInlineAxis ?? formatInlineAxisTick : undefined;
  const rightAxisFormat = inline ? items[1]?.formatInlineAxis ?? formatInlineAxisTick : undefined;
  const leftAxisItem = items[0];
  const leftAxisRange = sharedRange ? axisRangeFor(sharedValueRange, leftAxisItem) : axisRangeFor(itemRanges[0], leftAxisItem);
  const leftAxis = sharedRange
    ? { unit: yAxisLabel, range: leftAxisRange, ticks: buildAxisTicks(leftAxisRange, leftAxisFormat ?? leftAxisItem?.formatAxis ?? ((value) => `${value}`)) }
    : { unit: leftAxisItem?.unit ?? yAxisLabel, range: leftAxisRange, ticks: buildAxisTicks(leftAxisRange, leftAxisFormat ?? leftAxisItem?.formatAxis ?? ((value) => `${value}`)) };
  const rightAxisItem = items[1];
  const rightAxisRange = rightAxisItem ? axisRangeFor(itemRanges[1], rightAxisItem) : undefined;
  const rightAxis = !sharedRange && items[1]
    ? { unit: items[1].unit, range: rightAxisRange, ticks: buildAxisTicks(rightAxisRange, rightAxisFormat ?? items[1].formatAxis) }
    : undefined;
  const series = items.map((item, index) => {
    const range = sharedRange
      ? leftAxis.range
      : index === 0
        ? leftAxis.range
        : index === 1
          ? rightAxis?.range
          : axisRangeFor(itemRanges[index], item);
    return { ...item, path: buildSeriesPath(visibleSamples, item, timeWindow, range) };
  });
  const gridPath = buildChartGridPath(timeTicks, leftAxis.ticks);

  return (
    <div className={`telemetry-chart${inline ? " telemetry-chart-inline" : " section-card"}`}>
      {!inline ? (
        <div className="telemetry-chart-header">
          <span className="telemetry-chart-title">
            {title}
          </span>
        </div>
      ) : null}
      <div className="telemetry-chart-frame" data-has-right-axis={rightAxis ? "true" : "false"}>
        <div className="telemetry-chart-axis-scale telemetry-chart-axis-scale-left" aria-hidden="true">
          {!inline ? <span className="telemetry-chart-axis-unit">{leftAxis.unit}</span> : null}
          {leftAxis.ticks.filter((tick) => tick.label).map((tick) => (
            <span className="telemetry-chart-axis-tick" key={`${tick.position}-${tick.label}`} style={{ top: `${tick.position}%` }}>
              {tick.label}
            </span>
          ))}
        </div>
        <div className="telemetry-chart-plot" aria-label={ariaLabel} role="img">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none">
            <path className="telemetry-chart-grid-line" d={gridPath} />
            {series.map((item) =>
              item.path ? (
                <path className={`telemetry-chart-line telemetry-chart-line-${item.graphClass}`} d={item.path} key={item.key} />
              ) : null
            )}
          </svg>
        </div>
        {rightAxis ? (
          <div className="telemetry-chart-axis-scale telemetry-chart-axis-scale-right" aria-hidden="true">
            {!inline ? <span className="telemetry-chart-axis-unit">{rightAxis.unit}</span> : null}
            {rightAxis.ticks.filter((tick) => tick.label).map((tick) => (
              <span className="telemetry-chart-axis-tick" key={`${tick.position}-${tick.label}`} style={{ top: `${tick.position}%` }}>
                {tick.label}
              </span>
            ))}
          </div>
        ) : null}
        <div className="telemetry-chart-axis telemetry-chart-axis-x" aria-hidden="true">
          {timeTicks.filter((tick) => tick.label).map((tick) => (
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

function SecondaryTelemetry({
  chartItemsByKey,
  groups,
  onTempUnitChange,
  telemetry,
  telemetryHistory,
  tempUnit
}: {
  chartItemsByKey: Map<string, TelemetryItem>;
  groups: SecondaryTelemetryGroup[];
  onTempUnitChange(unit: TempUnit): void;
  telemetry?: Record<string, number>;
  telemetryHistory: TelemetrySample[];
  tempUnit: TempUnit;
}) {
  return (
    <div className="grouped-panel-grid">
      {groups.map(({ icon: Icon, items, title }) => (
        <GroupedPanel
          actions={
            title === "Thermal" ? (
              <div className="segmented telemetry-unit-toggle" role="radiogroup" aria-label="Telemetry temperature units">
                {(["C", "F"] as const).map((unit) => (
                  <button
                    aria-checked={tempUnit === unit}
                    aria-pressed={tempUnit === unit}
                    className="segmented-option"
                    key={unit}
                    onClick={() => onTempUnitChange(unit)}
                    role="radio"
                    type="button"
                  >
                    °{unit}
                  </button>
                ))}
              </div>
            ) : null
          }
          className="telemetry-secondary-group"
          icon={Icon}
          key={title}
          title={title}
        >
          <dl className="grouped-panel-list">
            {items.map((item) => {
              const value = telemetry?.[item.key];
              const chartItem = item.graphClass ? chartItemsByKey.get(item.key) : undefined;
              const helpId = `telemetry-help-${item.key}`;
              return (
                <div className={`grouped-panel-row telemetry-secondary-row${chartItem ? " telemetry-secondary-row-with-chart" : ""}`} key={item.key}>
                  <dt>
                    <span>{item.label}</span>
                    <span className="tooltip-anchor telemetry-field-help">
                      <button aria-describedby={helpId} aria-label={`${item.label} details`} className="icon-help" type="button">
                        <CircleHelp size={13} />
                      </button>
                      <span className="tooltip-bubble" id={helpId} role="tooltip">
                        {item.description}
                      </span>
                    </span>
                  </dt>
                  <dd>{value === undefined ? "—" : item.format(value)}</dd>
                  {chartItem ? (
                    <div className="telemetry-secondary-inline-chart">
                      <TelemetryGraph
                        ariaLabel={`Live Bluetooth ${item.label} graph`}
                        inline
                        items={[chartItem]}
                        samples={telemetryHistory}
                        title={item.label}
                        yAxisLabel={chartItem.unit}
                      />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </dl>
        </GroupedPanel>
      ))}
    </div>
  );
}

function SettingControl({
  busy,
  onDraftChange,
  setting,
  snapshot
}: {
  busy: boolean;
  onDraftChange(setting: BleSettingDraft, value: number): void;
  setting: BleSettingDraft;
  snapshot?: BleSnapshot;
}) {
  const writable = Boolean(snapshot && !snapshot.readOnly && setting.writable && !busy);
  const segmented = setting.options && setting.options.length > 0;

  if (segmented) {
    return (
      <div className="segmented" role="radiogroup" aria-label={setting.name}>
        {setting.options!.map((option) => (
          <button
            aria-checked={setting.draftValue === option.value}
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
    );
  }

  return (
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
  );
}

export function BlePanel({
  snapshot,
  telemetryHistory
}: {
  snapshot?: BleSnapshot;
  telemetryHistory: TelemetrySample[];
}) {
  const appliedTempUnit = snapshot?.settings.find((setting) => setting.id === 15)?.value === 1 ? "F" : "C";
  const [tempUnit, setTempUnit] = useState<TempUnit>(appliedTempUnit);
  useEffect(() => {
    setTempUnit(appliedTempUnit);
  }, [appliedTempUnit]);

  const chartTelemetryItems = useMemo(() => makeChartTelemetryItems(tempUnit), [tempUnit]);
  const secondaryTelemetryGroups = useMemo(() => makeSecondaryTelemetryGroups(tempUnit), [tempUnit]);
  const chartItemsByKey = useMemo(() => new Map(chartTelemetryItems.map((item) => [item.key, item])), [chartTelemetryItems]);

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

      <SecondaryTelemetry
        chartItemsByKey={chartItemsByKey}
        groups={secondaryTelemetryGroups}
        onTempUnitChange={setTempUnit}
        telemetry={snapshot?.telemetry}
        telemetryHistory={telemetryHistory}
        tempUnit={tempUnit}
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
  const groupedDrafts = useMemo(() => {
    const byId = new Map(drafts.map((setting) => [setting.id, setting]));
    const groupedIds = new Set<number>();
    const groups = settingsGroupDefinitions.map(({ icon, ids, title }) => {
      const settings = ids.flatMap((id) => {
        const setting = byId.get(id);
        if (setting) groupedIds.add(id);
        return setting ? [setting] : [];
      });
      return { icon, settings, title };
    }).filter((group) => group.settings.length > 0);

    const otherSettings = drafts.filter((setting) => !groupedIds.has(setting.id));
    return otherSettings.length
      ? [...groups, { title: "Other", icon: Gauge, settings: otherSettings }]
      : groups;
  }, [drafts]);

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

      <div className="grouped-panel-grid">
        {groupedDrafts.map(({ icon: Icon, settings, title }) => (
          <GroupedPanel className="telemetry-secondary-group" icon={Icon} key={title} title={title}>
            <dl className="grouped-panel-list">
              {settings.map((setting) => {
                const helpId = `setting-help-${setting.id}`;
                return (
                  <div className="grouped-panel-row telemetry-secondary-row settings-row" data-dirty={setting.dirty ? "true" : "false"} key={setting.id}>
                    <dt>
                      <span>{setting.name}</span>
                      <span className="tooltip-anchor telemetry-field-help">
                        <button aria-describedby={helpId} aria-label={`${setting.name} details`} className="icon-help" type="button">
                          <CircleHelp size={13} />
                        </button>
                        <span className="tooltip-bubble" id={helpId} role="tooltip">
                          {setting.description}
                          {!setting.writable ? " This setting is read-only from Bluetooth." : setting.dirty ? " This change is staged." : ""}
                        </span>
                      </span>
                      {!setting.writable ? (
                        <span className="settings-row-meta" data-tone="neutral">Read-only</span>
                      ) : setting.dirty ? (
                        <span className="settings-row-meta" data-tone="accent">Staged</span>
                      ) : null}
                    </dt>
                    <dd>
                      <SettingControl busy={busy} onDraftChange={onDraftChange} setting={setting} snapshot={snapshot} />
                    </dd>
                  </div>
                );
              })}
            </dl>
          </GroupedPanel>
        ))}
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
