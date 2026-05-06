import { unzipSync } from "fflate";
import { DEFAULT_LANGUAGES, firmwareFileName } from "@/lib/catalog/releases";
import type { LanguageOption, PinecilModel } from "@/lib/types";

type ZipEntries = Record<string, Uint8Array>;

function entriesFrom(bytes: Uint8Array): ZipEntries {
  return unzipSync(bytes, {
    filter(file) {
      return !file.name.endsWith("/");
    }
  });
}

export function extractFirmwareFromZip(bytes: Uint8Array, model: PinecilModel, language: string): Uint8Array {
  const entries = entriesFrom(bytes);
  const wanted = firmwareFileName(model, language).toLowerCase();
  const entryName = Object.keys(entries).find((name) => name.split("/").at(-1)?.toLowerCase() === wanted);
  if (!entryName) {
    throw new Error(`Firmware file ${firmwareFileName(model, language)} was not found in the archive.`);
  }
  return entries[entryName];
}

export function parseLanguagesFromMetadata(bytes: Uint8Array, model: PinecilModel): LanguageOption[] {
  const entries = entriesFrom(bytes);
  const jsonName = `${model === "v1" ? "Pinecil" : "Pinecilv2"}.json`.toLowerCase();
  const entryName = Object.keys(entries).find((name) => name.split("/").at(-1)?.toLowerCase() === jsonName);
  if (!entryName) return DEFAULT_LANGUAGES;

  const raw = new TextDecoder().decode(entries[entryName]);
  const parsed = JSON.parse(raw) as {
    contents?: Record<string, { language_code?: string; language_name?: string }>;
  };

  const languages = Array.from(
    Object.values(parsed.contents ?? {})
      .filter((entry) => entry.language_code && entry.language_name)
      .reduce((seen, entry) => {
        const code = String(entry.language_code);
        if (!seen.has(code)) seen.set(code, { code, name: String(entry.language_name) });
        return seen;
      }, new Map<string, LanguageOption>())
      .values()
  ).sort((a, b) => a.name.localeCompare(b.name));

  return languages.length ? languages : DEFAULT_LANGUAGES;
}
