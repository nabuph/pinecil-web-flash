import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/app-shell";

describe("AppShell connection actions", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      }))
    });
    document.body.classList.remove("fades-ready");
  });

  it("adds .fades-ready to body after mount so subsequent remounts can fade in", async () => {
    expect(document.body).not.toHaveClass("fades-ready");

    await act(async () => {
      render(<AppShell />);
    });

    // The mount effect tags the body so CSS @starting-style fires for
    // any .fade-in element inserted after the initial paint. The
    // selector is `.fades-ready .fade-in`, so elements rendered during
    // the very first commit don't match and don't fade.
    expect(document.body).toHaveClass("fades-ready");
  });

  it("connects the USB demo target from the splash controls", async () => {
    await act(async () => {
      render(<AppShell />);
    });

    act(() => {
      fireEvent.click(screen.getAllByRole("button", { name: "USB demo" }).at(-1)!);
    });

    expect(screen.getAllByText("Pinecil V2 connected via USB")).toHaveLength(2);
    // Sidebar shows "Flash mode" on its own line; mobile header collapses
    // the meta into a single slash-separated string. Both should be present.
    expect(screen.getByText("Flash mode")).toBeInTheDocument();
    expect(screen.getAllByText(/Flash mode/).length).toBeGreaterThanOrEqual(2);
  });

  it("connects the Bluetooth demo target from the splash controls", async () => {
    await act(async () => {
      render(<AppShell />);
    });

    act(() => {
      fireEvent.click(screen.getAllByRole("button", { name: "Bluetooth demo" }).at(-1)!);
    });

    expect(screen.getAllByText("Pinecil V2 connected via Bluetooth")).toHaveLength(2);
    expect(screen.getByText("Firmware v2.23-demo")).toBeInTheDocument();
  });
});
