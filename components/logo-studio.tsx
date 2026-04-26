"use client";

import { useEffect, useRef, useState } from "react";
import { CircleHelp, Download, Loader2, ShieldCheck, Upload, Zap } from "lucide-react";
import type { FlashTarget, GeneratedLogo, LogoPanOffset } from "@/lib/types";
import { EmptyConnectNotice, FileInput, SafetyChecklist } from "@/components/shared";

function renderPixels(pixels: Uint8Array) {
  return (
    <span className="pixel-grid">
      {Array.from(pixels).map((pixel, index) => (
        <i data-on={pixel ? "true" : "false"} key={index} />
      ))}
    </span>
  );
}

export function LogoStudio({
  busy,
  converting,
  generatedLogo,
  imagePan,
  invert,
  logoDfuFile,
  onDownload,
  onErase,
  onFlash,
  onImageFile,
  onImagePan,
  onInvert,
  onLogoDfuFile,
  onSafetyChange,
  onThreshold,
  safety,
  safetyReady,
  target,
  threshold
}: {
  busy: boolean;
  converting: boolean;
  generatedLogo?: GeneratedLogo;
  imagePan: LogoPanOffset;
  invert: boolean;
  logoDfuFile?: File;
  onDownload(): void;
  onErase(): void;
  onFlash(): void;
  onImageFile(file: File): void;
  onImagePan(value: LogoPanOffset): void;
  onInvert(value: boolean): void;
  onLogoDfuFile(file: File): void;
  onSafetyChange(value: boolean[]): void;
  onThreshold(value: number): void;
  safety: boolean[];
  safetyReady: boolean;
  target?: FlashTarget;
  threshold: number;
}) {
  const disabled = !target || busy;
  const [buttonsConverting, setButtonsConverting] = useState(converting);
  const actionDisabled = disabled || buttonsConverting;
  const [thresholdValue, setThresholdValue] = useState(threshold);
  const [isRepositioning, setIsRepositioning] = useState(false);
  const thresholdTimer = useRef<number | undefined>(undefined);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startPan: LogoPanOffset;
    width: number;
    height: number;
  } | undefined>(undefined);
  const canPanImage = Boolean(generatedLogo && !generatedLogo.isErase && !disabled);

  useEffect(() => {
    setThresholdValue(threshold);
  }, [threshold]);

  useEffect(() => {
    setButtonsConverting(converting || isRepositioning);
  }, [converting, isRepositioning]);

  useEffect(() => () => {
    if (thresholdTimer.current !== undefined) window.clearTimeout(thresholdTimer.current);
  }, []);

  const handleThreshold = (value: number) => {
    setThresholdValue(value);
    if (thresholdTimer.current !== undefined) window.clearTimeout(thresholdTimer.current);
    thresholdTimer.current = window.setTimeout(() => onThreshold(value), 120);
  };

  const clampPan = (value: number) => Math.min(1, Math.max(-1, value));
  const zoomValue = imagePan.zoom ?? 1;
  const restoreDefaultHelpId = "restore-default-boot-logo-help";
  const restoreDefaultHelp = "Creates a .dfu file that removes the custom boot logo, so the iron shows the firmware default again.";

  const finishRepositioning = () => {
    setIsRepositioning(false);
    if (!converting) setButtonsConverting(false);
  };

  return (
    <div className="panel-section">
      <div className="section-heading">
        <div className="section-heading-text">
          <h2>Boot Logo</h2>
          <p>Generate a 96×16 boot-logo .dfu file from any image, or flash an existing .dfu file.</p>
        </div>
      </div>

      {!target ? <EmptyConnectNotice /> : null}

      <div className="section-card">
        <div className="section-card-body">
          <div className="logo-grid">
            {/* Drop zone */}
            <label
              className="drop-zone"
              onDragOver={(e) => { if (!disabled) e.preventDefault(); }}
              onDrop={(e) => {
                if (disabled) return;
                e.preventDefault();
                const file = e.dataTransfer.files?.[0];
                if (file) onImageFile(file);
              }}
            >
              {busy ? (
                <Loader2 className="spin" size={24} />
              ) : (
                <>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                    <circle cx="8.5" cy="8.5" r="1.5"/>
                    <polyline points="21 15 16 10 5 21"/>
                  </svg>
                  <strong>Drop an image or click to browse</strong>
                  <span>PNG, JPEG, WebP, BMP · GIF/APNG uses first frame</span>
                </>
              )}
              <input
                accept="image/png,image/jpeg,image/webp,image/bmp,image/gif,image/apng,.apng"
                disabled={disabled}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) onImageFile(file);
                  e.target.value = "";
                }}
                type="file"
              />
            </label>

            {/* Preview */}
            <div className="logo-preview-card">
              <div
                aria-label="96×16 logo preview"
                className="logo-screen"
                data-pannable={canPanImage ? "true" : "false"}
                onPointerDown={(e) => {
                  if (!canPanImage) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  dragRef.current = {
                    pointerId: e.pointerId,
                    startX: e.clientX,
                    startY: e.clientY,
                    startPan: imagePan,
                    width: rect.width,
                    height: rect.height
                  };
                  setIsRepositioning(true);
                  setButtonsConverting(true);
                  e.currentTarget.setPointerCapture(e.pointerId);
                  e.preventDefault();
                }}
                onPointerMove={(e) => {
                  const drag = dragRef.current;
                  if (!drag || drag.pointerId !== e.pointerId) return;
                  onImagePan({
                    x: clampPan(drag.startPan.x + ((e.clientX - drag.startX) / drag.width) * 2),
                    y: clampPan(drag.startPan.y + ((e.clientY - drag.startY) / drag.height) * 2),
                    zoom: drag.startPan.zoom ?? 1
                  });
                }}
                onPointerUp={(e) => {
                  if (dragRef.current?.pointerId === e.pointerId) {
                    dragRef.current = undefined;
                    finishRepositioning();
                  }
                  if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
                }}
                onPointerCancel={(e) => {
                  if (dragRef.current?.pointerId === e.pointerId) {
                    dragRef.current = undefined;
                    finishRepositioning();
                  }
                  if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
                }}
                title={canPanImage ? "Drag to reposition. Use Zoom to crop in before dragging horizontally or vertically." : undefined}
              >
                {generatedLogo ? renderPixels(generatedLogo.pixels) : <span>PINE64</span>}
              </div>
              <p style={{ fontSize: 11, color: "var(--fg-subtle)", marginTop: 4 }}>
                {generatedLogo?.formatNote ?? "96×16 monochrome preview"}
              </p>
              <div className="logo-controls">
                <label className="logo-controls-label">
                  Threshold
                  <input
                    disabled={disabled}
                    max={240}
                    min={16}
                    onChange={(e) => handleThreshold(Number(e.target.value))}
                    type="range"
                    value={thresholdValue}
                  />
                </label>
                <label className="logo-controls-label">
                  Zoom
                  <input
                    disabled={!canPanImage}
                    max={4}
                    min={1}
                    onChange={(e) => onImagePan({ ...imagePan, zoom: Number(e.target.value) })}
                    step={0.05}
                    type="range"
                    value={zoomValue}
                  />
                </label>
                <label className="logo-controls-toggle">
                  <input
                    checked={invert}
                    disabled={disabled}
                    onChange={(e) => onInvert(e.target.checked)}
                    type="checkbox"
                  />
                  Invert
                </label>
              </div>
            </div>
          </div>
        </div>

        <div className="section-card-body">
          <div className="btn-row">
            <FileInput
              accept=".dfu"
              disabled={actionDisabled}
              icon={Upload}
              label="Choose existing .dfu file"
              onFile={onLogoDfuFile}
            />
            <span className="logo-restore-action">
              <button
                className="btn"
                disabled={actionDisabled}
                onClick={onErase}
                type="button"
              >
                <ShieldCheck size={14} /> Restore default boot logo
              </button>
              <span className="tooltip-anchor">
                <button
                  aria-describedby={restoreDefaultHelpId}
                  aria-label="About restoring the default boot logo"
                  className="icon-help"
                  type="button"
                >
                  <CircleHelp size={14} />
                </button>
                <span className="tooltip-bubble" id={restoreDefaultHelpId} role="tooltip">
                  {restoreDefaultHelp}
                </span>
              </span>
            </span>
          </div>
        </div>
      </div>

      <SafetyChecklist disabled={disabled} onChange={onSafetyChange} values={safety} />

      <div className="flash-action-bar">
        <button
          className="btn"
          disabled={!generatedLogo || actionDisabled}
          onClick={onDownload}
          type="button"
        >
          <Download size={14} /> Download .dfu file
        </button>
        <button
          className="btn btn-primary"
          disabled={!target || !safetyReady || actionDisabled || (!generatedLogo && !logoDfuFile)}
          onClick={onFlash}
          type="button"
        >
          {busy ? <Loader2 className="spin" size={14} /> : <Zap size={14} />}
          Flash Logo
        </button>
      </div>
    </div>
  );
}
