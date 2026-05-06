"use client";

import { Bluetooth, Cpu, FileImage, Moon, Monitor, SlidersHorizontal, Sun, Unplug } from "lucide-react";
import type { ElementType } from "react";
import { Pine64Logo } from "@/components/pine64-logo";
import type { FlashTarget } from "@/lib/types";

export type Mode = "firmware" | "logo" | "ble" | "ble-settings";
export type ThemePreference = "system" | "light" | "dark";
export type ModeAvailability = Partial<Record<Mode, string>>;

const modeItems: Array<{ value: Mode; label: string; icon: ElementType }> = [
  { value: "firmware",     label: "Firmware",    icon: Cpu               },
  { value: "logo",         label: "Boot Logo",   icon: FileImage         },
  { value: "ble",          label: "Telemetry",   icon: Bluetooth         },
  { value: "ble-settings", label: "Settings",    icon: SlidersHorizontal }
];

const themeItems: Array<{ value: ThemePreference; label: string; icon: ElementType }> = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light",  label: "Light",  icon: Sun     },
  { value: "dark",   label: "Dark",   icon: Moon    }
];

const footerLinks = [
  { label: "Official Pinecil", href: "https://pine64.org/devices/pinecil/" },
  { label: "IronOS firmware", href: "https://github.com/Ralim/IronOS" },
  { label: "PINE64 community", href: "https://pine64.org/community/" }
];

export function Sidebar({
  bluetoothLabel,
  busy,
  firmwareVersion,
  bootRomVersion,
  modeAvailability,
  modeHelp,
  mode,
  onDisconnect,
  onMode,
  onTheme,
  target,
  theme
}: {
  bluetoothLabel: string;
  busy: boolean;
  // IronOS firmware version reported either by Bluetooth (running IronOS)
  // or by reading flash via the eflash_loader during BLISP connect. For the
  // demo target this is a faked string. Undefined if we couldn't determine
  // it.
  firmwareVersion?: string;
  // BL70x boot ROM version reported during BLISP handshake. Only set when
  // connected via USB in flash mode.
  bootRomVersion?: string;
  modeAvailability: ModeAvailability;
  modeHelp: string;
  mode?: Mode;
  onDisconnect(): void;
  onMode(m: Mode): void;
  onTheme(t: ThemePreference): void;
  target?: FlashTarget;
  theme: ThemePreference;
}) {
  const bluetoothConnected = bluetoothLabel === "Connected";
  const usbConnected = Boolean(target);
  const connected = usbConnected || bluetoothConnected;
  const model = target?.model ?? (bluetoothConnected ? "v2" : undefined);
  const transportLabel = usbConnected ? "USB" : bluetoothConnected ? "Bluetooth" : undefined;
  const displayName = model && transportLabel
    ? `Pinecil ${model.toUpperCase()} connected via ${transportLabel}`
    : "No device connected";
  const modeLine = connected ? (target?.bootloader ? "Flash mode" : "Normal mode") : undefined;
  const firmwareLine = firmwareVersion ? `Firmware ${firmwareVersion}` : undefined;
  const bootRomLine = bootRomVersion ? `Boot ROM ${bootRomVersion}` : undefined;

  return (
    <aside className="sidebar">
      <div className="sidebar-scroll">
      {/* Brand */}
      <div className="sidebar-brand">
        <span className="sidebar-brand-icon" aria-hidden="true">
          <Pine64Logo size={22} />
        </span>
        <div className="sidebar-brand-text">
          <strong>Pinecil Web Flash</strong>
        </div>
      </div>

      {/* Mode navigation */}
      <nav className="sidebar-nav" aria-label="Workspace modes">
        {modeItems.map(({ value, label, icon: Icon }) => {
          const disabledReason = modeAvailability[value];
          return (
            <button
              aria-label={label}
              aria-pressed={mode === value}
              className="sidebar-nav-item"
              disabled={Boolean(disabledReason)}
              key={value}
              onClick={() => onMode(value)}
              title={disabledReason ?? label}
              type="button"
            >
              <Icon size={15} />
              <span className="sidebar-nav-label">{label}</span>
            </button>
          );
        })}
      </nav>

      <div className="sidebar-divider" />

      {/* Device section */}
      <div className="sidebar-device">
        <div className="sidebar-device-info">
          <div className="sidebar-device-name" data-connected={connected ? "true" : "false"}>
            <span className="sidebar-connection-indicator" aria-hidden="true">
              <span className="sidebar-connection-dot" />
            </span>
            <span className="fade-in" key={displayName}>{displayName}</span>
          </div>
          {(firmwareLine || bootRomLine || modeLine) ? (
            <div className="sidebar-device-meta fade-in" key={`${firmwareLine ?? ""}-${bootRomLine ?? ""}-${modeLine ?? ""}`}>
              {firmwareLine ? <div>{firmwareLine}</div> : null}
              {bootRomLine ? <div>{bootRomLine}</div> : null}
              {modeLine ? <div>{modeLine}</div> : null}
            </div>
          ) : null}
          {connected && modeHelp ? <p className="sidebar-mode-help fade-in" key={modeHelp}>{modeHelp}</p> : null}
        </div>

        {connected ? (
          <div className="sidebar-connect-btns fade-in">
            <button
              className="btn btn-sm"
              disabled={busy}
              onClick={onDisconnect}
              type="button"
            >
              <Unplug size={13} />
              Disconnect
            </button>
          </div>
        ) : null}
      </div>
      </div>

      <footer className="sidebar-footer">
        <p className="sidebar-footer-tagline">Open. Friendly. Community Driven.</p>
        <p className="sidebar-footer-disclaimer">
          This project is not official, administered by, or endorsed by PINE64.
        </p>
        <nav className="sidebar-footer-links" aria-label="Project links">
          {footerLinks.map((link) => (
            <a href={link.href} key={link.href} rel="noreferrer" target="_blank">
              {link.label}
            </a>
          ))}
        </nav>
        <ThemeSwitch onTheme={onTheme} theme={theme} />
      </footer>
    </aside>
  );
}

export function ThemeSwitch({
  onTheme,
  theme
}: {
  onTheme(t: ThemePreference): void;
  theme: ThemePreference;
}) {
  return (
    <div className="theme-switch" aria-label="Select display theme">
      {themeItems.map(({ value, label, icon: Icon }) => (
        <button
          aria-label={label}
          aria-pressed={theme === value}
          key={value}
          onClick={() => onTheme(value)}
          title={label}
          type="button"
        >
          <Icon size={13} />
        </button>
      ))}
    </div>
  );
}
