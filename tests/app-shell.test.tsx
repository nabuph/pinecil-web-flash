import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    Object.defineProperty(navigator, "serial", {
      configurable: true,
      value: undefined
    });
    Object.defineProperty(navigator, "usb", {
      configurable: true,
      value: undefined
    });
    Object.defineProperty(navigator, "bluetooth", {
      configurable: true,
      value: undefined
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

  it("reads the installed firmware version from the sidebar on demand", async () => {
    const versionBytes = new TextEncoder().encode("build v2.23");
    const chunks = [
      new Uint8Array([0x4f, 0x4b]),
      new Uint8Array([0x4f, 0x4b]),
      new Uint8Array([0x04, 0x00]),
      new Uint8Array([1, 2, 3, 4]),
      new Uint8Array([0x4f, 0x4b]),
      new Uint8Array([0x04, 0x00]),
      new Uint8Array([0xff, 0xff, 0xff, 0xff]),
      new Uint8Array([0x4f, 0x4b]),
      new Uint8Array([versionBytes.length, 0x00]),
      versionBytes
    ];
    const port = {
      open: vi.fn(async () => undefined),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      close: vi.fn(async () => undefined),
      getInfo: () => ({ usbVendorId: 0x1a86, usbProductId: 0x55d4 }),
      readable: new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = chunks.shift();
          if (chunk) controller.enqueue(chunk);
          else controller.close();
        }
      }),
      writable: new WritableStream<Uint8Array>()
    };
    Object.defineProperty(navigator, "serial", {
      configurable: true,
      value: { requestPort: vi.fn(async () => port) }
    });

    await act(async () => {
      render(<AppShell />);
    });

    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Connect USB" }).at(-1)!);
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Read firmware" })).toBeInTheDocument();
    });
    expect(screen.queryByText("Firmware v2.23")).not.toBeInTheDocument();
    expect(screen.queryByText("Boot ROM 1.2.3.4")).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Read firmware" }));
    });

    await waitFor(() => {
      expect(screen.getByText("Firmware v2.23")).toBeInTheDocument();
    });
    expect(screen.getByText("Boot ROM 1.2.3.4")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Read firmware" })).not.toBeInTheDocument();
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

  it("logs when Chrome closes the USB chooser without a selected device", async () => {
    Object.defineProperty(navigator, "serial", {
      configurable: true,
      value: {
        getPorts: vi.fn(async () => []),
        requestPort: vi.fn(async () => {
          throw Object.assign(new Error("No port selected"), { name: "NotFoundError" });
        })
      }
    });

    await act(async () => {
      render(<AppShell />);
    });

    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Connect USB" }).at(-1)!);
    });

    await waitFor(() => {
      expect(screen.getByText(/Chrome closed the USB device chooser/)).toBeInTheDocument();
    });
  });
});
