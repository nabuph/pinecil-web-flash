"use client";

import { CheckCircle2, ChevronDown, Trash2, XCircle } from "lucide-react";
import React from "react";
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

const indeterminatePhases: FlashPhase[] = ["validate", "detect"];

export function ActivityLog({
  fileName,
  logs,
  onClear,
  onOpenChange,
  open,
  phase,
  progress,
  progressMessage,
  target
}: {
  fileName: string;
  logs: LogLine[];
  onClear(): void;
  onOpenChange(open: boolean): void;
  open: boolean;
  phase: FlashPhase;
  progress: number;
  progressMessage: string;
  target: string;
}) {
  const isIndeterminate = indeterminatePhases.includes(phase);
  const fillPct = isIndeterminate ? 0 : progress;
  const activityState = phase === "done" ? "success" : phase === "fail" ? "fail" : "active";

  return (
    <div className="activity-panel">
      <div className="activity-bar">
        <button className="activity-bar-main" onClick={() => onOpenChange(!open)} type="button">
          <span className="activity-bar-toggle" data-open={open ? "true" : "false"}>
            <ChevronDown size={12} />
            Activity
          </span>

          <div className="activity-progress-wrap">
            <div className="activity-progress-track">
              <div
                className="activity-progress-fill"
                data-indeterminate={isIndeterminate ? "true" : "false"}
                data-state={activityState}
                style={{ width: `${fillPct}%` }}
              />
            </div>
            {progress > 0 && !isIndeterminate ? (
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
          <dl className="activity-meta">
            <div className="activity-meta-row">
              <dt>Target</dt>
              <dd>{target}</dd>
            </div>
            <div className="activity-meta-row">
              <dt>File</dt>
              <dd>{fileName}</dd>
            </div>
            <div className="activity-meta-row">
              <dt>Status</dt>
              <dd>{progressMessage}</dd>
            </div>
          </dl>
          <div className="log-list" aria-live="polite">
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
