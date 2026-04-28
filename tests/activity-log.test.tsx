import React, { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ActivityLog, type LogLine } from "@/components/activity-log";
import type { FlashPhase } from "@/lib/types";

const logs: LogLine[] = [
  { time: "12:00:00", level: "INFO", message: "Ready." }
];

function ActivityHarness({ phase, pulse = false }: { phase: FlashPhase; pulse?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <ActivityLog
      fileName="Pinecilv2_EN.bin"
      logs={logs}
      onClear={vi.fn()}
      onOpenChange={setOpen}
      open={open}
      phase={phase}
      pulse={pulse}
      progress={phase === "connect" ? 0 : 100}
      progressMessage={phase === "fail" ? "Flash failed." : "Ready."}
      target="Pinecil V2 demo target"
    />
  );
}

function renderActivity(phase: FlashPhase = "connect") {
  return render(<ActivityHarness phase={phase} />);
}

describe("ActivityLog", () => {
  it("only shows the clear button when the log is expanded", () => {
    renderActivity();

    expect(screen.queryByRole("button", { name: "Clear log" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Activity Waiting for device" }));

    expect(screen.getByRole("button", { name: "Clear log" })).toBeInTheDocument();
  });

  it("renders success and fail status states", () => {
    const { container, rerender } = renderActivity("done");

    expect(screen.getByText("Complete").closest(".activity-phase")).toHaveAttribute("data-state", "success");
    expect(container.querySelector(".activity-progress-fill")).toHaveAttribute("data-state", "success");

    rerender(<ActivityHarness phase="fail" />);

    expect(screen.getByText("Failed").closest(".activity-phase")).toHaveAttribute("data-state", "fail");
    expect(container.querySelector(".activity-progress-fill")).toHaveAttribute("data-state", "fail");
  });

  it("does not pulse the progress track during flash writes", () => {
    const { container } = renderActivity("flash");

    expect(container.querySelector(".activity-progress-track")).toHaveAttribute("data-pulse", "false");
  });

  it("does not pulse while idly waiting on page load", () => {
    const { container } = renderActivity("connect");

    expect(container.querySelector(".activity-progress-track")).toHaveAttribute("data-pulse", "false");
  });

  it("can pulse the connect phase after the user starts connecting", () => {
    const { container } = render(<ActivityHarness phase="connect" pulse />);

    expect(container.querySelector(".activity-progress-track")).toHaveAttribute("data-pulse", "true");
  });

  it("pulses the progress track while preparing", () => {
    const { container, rerender } = renderActivity("connect");

    expect(container.querySelector(".activity-progress-track")).toHaveAttribute("data-pulse", "false");

    rerender(<ActivityHarness phase="validate" />);

    expect(container.querySelector(".activity-progress-track")).toHaveAttribute("data-pulse", "true");
  });

  it("pulses the progress track while verifying", () => {
    const { container } = renderActivity("verify");

    expect(container.querySelector(".activity-progress-track")).toHaveAttribute("data-pulse", "true");
  });

  it("can pulse the progress track for Bluetooth activity outside flash phases", () => {
    const { container } = render(<ActivityHarness phase="select" pulse />);

    expect(container.querySelector(".activity-progress-track")).toHaveAttribute("data-pulse", "true");
  });
});
