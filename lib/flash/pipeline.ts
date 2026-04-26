import { validateInstallFileName } from "@/lib/firmware/validation";
import type { FlashInput, FlashProgress, FlashResult, FlashTarget, FlasherBackend, InstallKind } from "@/lib/types";
import { sha256Hex } from "@/lib/utils/hash";

export interface InstallSelection {
  kind: InstallKind;
  fileName: string;
  bytes: Uint8Array;
  releaseTag?: string;
  language?: string;
}

export interface PreparedInstallFile extends FlashInput {
  warnings: string[];
}

export async function prepareInstall(target: FlashTarget, selection: InstallSelection): Promise<PreparedInstallFile> {
  const warnings = validateInstallFileName(selection.fileName, target.model, selection.kind, selection.language);
  if (warnings.length) {
    throw new Error(warnings.join(" "));
  }

  return {
    model: target.model,
    kind: selection.kind,
    fileName: selection.fileName,
    bytes: selection.bytes,
    releaseTag: selection.releaseTag,
    language: selection.language,
    sha256: await sha256Hex(selection.bytes),
    warnings
  };
}

export async function flashPrepared(
  target: FlashTarget,
  backend: FlasherBackend | undefined,
  prepared: PreparedInstallFile,
  onProgress: (event: FlashProgress) => void
): Promise<FlashResult> {
  if (target.transport === "demo") return simulatePreparedFlash(prepared, onProgress);
  if (!backend) throw new Error("No hardware backend is connected.");
  return backend.flash(prepared, onProgress);
}

export async function simulatePreparedFlash(prepared: PreparedInstallFile, onProgress: (event: FlashProgress) => void): Promise<FlashResult> {
  const total = prepared.bytes.length;
  for (const percent of [8, 24, 48, 72, 92, 100]) {
    await new Promise((resolve) => setTimeout(resolve, 90));
    onProgress({
      phase: percent < 92 ? "flash" : "verify",
      message: `${prepared.fileName}: simulated ${percent}%`,
      current: Math.round((total * percent) / 100),
      total,
      level: percent === 100 ? "success" : "info"
    });
  }
  return {
    ok: true,
    message: "Demo flash completed.",
    verifySummary: "Demo verification completed without hardware writes."
  };
}
