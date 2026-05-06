"use client";

import { CheckCircle2, ChevronDown, Trash2, XCircle } from "lucide-react";
import { useEffect, useRef } from "react";
import type { FlashPhase } from "@/lib/types";

export type LogLine = { time: string; level: "INFO" | "WARN" | "ERROR" | "OK"; message: string };

const phaseLabels: Record<FlashPhase, string> = {
  connect:  "Waiting for device",
  detect:   "Device detected",
  select:   "Ready to flash",
  validate: "Validating",
  flash:    "Writing",
  verify:   "Verifying",
  done:     "Complete",
  fail:     "Failed"
};

const indeterminatePhases: FlashPhase[] = ["validate"];
const pulsingPhases: FlashPhase[] = ["detect", "validate", "verify"];

export function ActivityLog({
  logs,
  onClear,
  onOpenChange,
  open,
  phase,
  pulse,
  progress
}: {
  logs: LogLine[];
  onClear(): void;
  onOpenChange(open: boolean): void;
  open: boolean;
  phase: FlashPhase;
  pulse?: boolean;
  progress: number;
}) {
  const isIndeterminate = indeterminatePhases.includes(phase);
  const fillPct = isIndeterminate ? 0 : progress;
  const activityState = phase === "done" ? "success" : phase === "fail" ? "fail" : "active";
  const isLongRunning = activityState === "active" && (pulsingPhases.includes(phase) || Boolean(pulse));
  const pulseOnly = Boolean(pulse) && activityState === "active" && phase !== "validate" && phase !== "flash" && phase !== "verify";
  const showProgressFill = !pulseOnly && (isIndeterminate || progress > 0 || activityState !== "active");
  const logListRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && logListRef.current) {
      logListRef.current.scrollTop = logListRef.current.scrollHeight;
    }
  }, [logs, open]);

  return (
    <div className="activity-panel">
      <div className="activity-bar">
        <button className="activity-bar-main" onClick={() => onOpenChange(!open)} type="button">
          <span className="activity-bar-toggle" data-open={open ? "true" : "false"}>
            <ChevronDown size={12} />
            Activity
          </span>

          <div className="activity-progress-wrap">
            <div className="activity-progress-track" data-pulse={isLongRunning ? "true" : "false"}>
              {showProgressFill ? (
                <div
                  className="activity-progress-fill"
                  data-indeterminate={isIndeterminate ? "true" : "false"}
                  data-state={activityState}
                  style={{ width: `${fillPct}%` }}
                />
              ) : null}
            </div>
            {showProgressFill && progress > 0 && !isIndeterminate ? (
              <span className="activity-progress-label">{progress}%</span>
            ) : null}
          </div>

          <span className="activity-phase" data-state={activityState}>
            {activityState === "success" ? <CheckCircle2 size={13} /> : null}
            {activityState === "fail" ? <XCircle size={13} /> : null}
            {phaseLabels[phase]}
          </span>
        </button>

        <div className="activity-bar-right">
          {open ? (
            <button
              className="btn btn-sm activity-clear-button"
              onClick={onClear}
              type="button"
            >
              <Trash2 size={12} />
              Clear log
            </button>
          ) : null}
        </div>
      </div>

      {open ? (
        <div className="activity-expanded">
          <div className="log-list" aria-live="polite" ref={logListRef}>
            {logs.map((line, index) => (
              <p key={`${line.time}-${index}`}>
                <span className="log-time">{line.time}</span>
                <b className="log-level" data-level={line.level}>{line.level}</b>
                <span className="log-msg">{line.message}</span>
              </p>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
