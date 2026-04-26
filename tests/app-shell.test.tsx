import React from "react";
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
  });

  it("connects the USB demo target from the splash controls", async () => {
    await act(async () => {
      render(<AppShell />);
    });

    act(() => {
      fireEvent.click(screen.getAllByRole("button", { name: "USB demo" }).at(-1)!);
    });

    expect(screen.getAllByText("Pinecil V2 connected via USB")).toHaveLength(2);
    expect(screen.getAllByText("Flash mode")).toHaveLength(2);
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
