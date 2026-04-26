"use client";

import { AlertTriangle, ExternalLink, Loader2, Zap } from "lucide-react";
import type { FirmwareRelease, FlashTarget, LanguageOption, ReleaseChannel } from "@/lib/types";
import { EmptyConnectNotice, SafetyChecklist } from "@/components/shared";

export function FirmwarePanel({
  busy,
  channelReleases,
  flashReady,
  language,
  languages,
  onChannel,
  onFlash,
  onLanguage,
  onPrereleaseConfirmed,
  onRelease,
  onSafetyChange,
  prereleaseConfirmed,
  releaseChannel,
  selectedRelease,
  selectedReleaseTag,
  safety,
  target
}: {
  busy: boolean;
  channelReleases: FirmwareRelease[];
  flashReady: boolean;
  language: string;
  languages: LanguageOption[];
  onChannel(channel: ReleaseChannel): void;
  onFlash(): void;
  onLanguage(language: string): void;
  onPrereleaseConfirmed(value: boolean): void;
  onRelease(tag: string): void;
  onSafetyChange(value: boolean[]): void;
  prereleaseConfirmed: boolean;
  releaseChannel: ReleaseChannel;
  selectedRelease?: FirmwareRelease;
  selectedReleaseTag: string;
  safety: boolean[];
  target?: FlashTarget;
}) {
  const disabled = !target || busy;

  return (
    <div className="panel-section">
      <div className="section-heading">
        <div className="section-heading-text">
          <h2>Firmware</h2>
          <p>Choose an IronOS release and language. Validation and verification run automatically when you flash.</p>
        </div>
      </div>

      {!target ? <EmptyConnectNotice /> : null}

      <div className="section-card">
        <div className="section-card-body">
          <div className="firmware-grid">
            <div className="field">
              <label className="field-label" htmlFor="release-channel">Channel</label>
              <select
                className="select"
                disabled={disabled}
                id="release-channel"
                onChange={(e) => onChannel(e.target.value as ReleaseChannel)}
                value={releaseChannel}
              >
                <option value="stable">Stable</option>
                <option value="prerelease">Beta / prerelease</option>
              </select>
            </div>

            <div className="field">
              <label className="field-label" htmlFor="release-tag">
                Release
                {selectedRelease?.htmlUrl ? (
                  <a
                    className="field-label-link"
                    href={selectedRelease.htmlUrl}
                    rel="noreferrer"
                    target="_blank"
                    title={`View ${selectedRelease.tag} on GitHub`}
                  >
                    <ExternalLink size={12} />
                  </a>
                ) : null}
              </label>
              <select
                className="select"
                disabled={disabled}
                id="release-tag"
                onChange={(e) => onRelease(e.target.value)}
                value={selectedReleaseTag}
              >
                {channelReleases.map((r) => (
                  <option value={r.tag} key={r.tag}>
                    {r.tag}{r.channel === "prerelease" ? " (beta)" : ""}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label className="field-label" htmlFor="language">Language</label>
              <select
                className="select"
                disabled={disabled}
                id="language"
                onChange={(e) => onLanguage(e.target.value)}
                value={language}
              >
                {languages.map((item) => (
                  <option value={item.code} key={item.code}>
                    {item.name} ({item.code})
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>

      <SafetyChecklist disabled={disabled} onChange={onSafetyChange} values={safety}>
        {selectedRelease?.channel === "prerelease" ? (
          <label className="safety-item safety-item-warning">
            <input
              checked={prereleaseConfirmed}
              disabled={disabled}
              onChange={(e) => onPrereleaseConfirmed(e.target.checked)}
              type="checkbox"
            />
            <AlertTriangle size={15} />
            <span>I understand this is prerelease firmware and may contain regressions.</span>
          </label>
        ) : null}
      </SafetyChecklist>

      <div className="flash-action-bar">
        <button
          className="btn btn-primary"
          disabled={!flashReady || busy}
          onClick={onFlash}
          type="button"
        >
          {busy ? <Loader2 className="spin" size={14} /> : <Zap size={14} />}
          Flash Firmware
        </button>
      </div>
    </div>
  );
}
