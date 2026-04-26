import { firmwareFileName } from "@/lib/catalog/releases";
import type { InstallKind, PinecilModel } from "@/lib/types";

export function expectedExtension(model: PinecilModel, kind: InstallKind): "dfu" | "bin" {
  if (kind === "bootLogo") return "dfu";
  return model === "v1" ? "dfu" : "bin";
}

export function validateInstallFileName(fileName: string, model: PinecilModel, kind: InstallKind, language?: string): string[] {
  const warnings: string[] = [];
  const extension = fileName.split(".").at(-1)?.toLowerCase();
  const expected = expectedExtension(model, kind);
  if (extension !== expected) {
    warnings.push(`${model.toUpperCase()} ${kind === "firmware" ? "firmware" : "boot logo"} expects .${expected} files.`);
  }
  if (kind === "firmware" && language) {
    const expectedName = firmwareFileName(model, language).toLowerCase();
    if (!fileName.toLowerCase().endsWith(expectedName)) {
      warnings.push(`Expected ${expectedName} for the selected language.`);
    }
  }
  if (kind === "bootLogo" && !/\.dfu$/i.test(fileName)) {
    warnings.push("Boot-logo flashing uses IronOS-generated .dfu logo files.");
  }
  return warnings;
}
