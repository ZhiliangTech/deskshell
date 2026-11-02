import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWindowsNotepadDriver, NOTEPAD_11_2607_ZH_CN_CANDIDATE_PROFILE } from "./notepad.ts";
import type { NativeNotepadProbe, TrustedNotepadProfile } from "./notepad.ts";
import type { NotepadDriver } from "../../runtime/src/notepad-task.ts";

/** Release gate: change only after the fixed/native/model/fault acceptance matrix. */
export const NOTEPAD_PROFILE_RELEASE_READY = true;
export const NOTEPAD_11_2607_ZH_CN_RELEASE_PROFILE: Readonly<TrustedNotepadProfile> = Object.freeze({
  ...NOTEPAD_11_2607_ZH_CN_CANDIDATE_PROFILE,
  id: "notepad-11.2607.14.0-zh-CN-v2", verified: true,
});
export interface NotepadInstalledMetadata { version: 1; packageVersions: string[]; uiLocale: string }
export interface NotepadProfileSelection {
  releaseReady: boolean;
  supportedEnvironment: boolean;
  available: boolean;
  reasons: string[];
  installedVersion?: string;
  installedLocale?: string;
  profile?: TrustedNotepadProfile;
}
export interface ServiceNotepadDriver extends NotepadDriver {
  probe(options?: { readOnly?: true; signal?: AbortSignal }): Promise<NativeNotepadProbe>;
  close(): void;
}
export interface SelectedNotepadDriver { driver: ServiceNotepadDriver; selection: NotepadProfileSelection }
type MetadataExecutor = (file: string, args: string[], options: { encoding: "utf8"; windowsHide: true; timeout: number; maxBuffer: number; stdio: ["ignore", "pipe", "pipe"] }) => string;
const object = (value: unknown): value is Record<string, unknown> => !!value && Object.getPrototypeOf(value) === Object.prototype;

/** Pure exact-match policy. Metadata does not prove an application's current UI language. */
export function matchNotepadEnvironment(platform: string, value: unknown): Omit<NotepadProfileSelection, "releaseReady" | "available" | "profile"> {
  if (platform !== "win32") return { supportedEnvironment: false, reasons: ["WINDOWS_REQUIRED"] };
  if (!object(value) || Object.keys(value).some((key) => !["version", "packageVersions", "uiLocale"].includes(key)) || value.version !== 1
    || !Array.isArray(value.packageVersions) || value.packageVersions.length > 16 || value.packageVersions.some((version) => typeof version !== "string" || !/^\d+\.\d+\.\d+\.\d+$/.test(version))
    || typeof value.uiLocale !== "string" || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(value.uiLocale)) {
    return { supportedEnvironment: false, reasons: ["NOTEPAD_METADATA_UNAVAILABLE"] };
  }
  const versions = value.packageVersions as string[];
  const observed = { ...(versions.length === 1 ? { installedVersion: versions[0] } : {}), installedLocale: value.uiLocale };
  if (versions.length !== 1) return { ...observed, supportedEnvironment: false, reasons: [versions.length ? "NOTEPAD_PACKAGE_AMBIGUOUS" : "NOTEPAD_NOT_INSTALLED"] };
  const reasons: string[] = [];
  if (versions[0] !== NOTEPAD_11_2607_ZH_CN_RELEASE_PROFILE.packageVersion) reasons.push("NOTEPAD_VERSION_UNSUPPORTED");
  if (value.uiLocale !== NOTEPAD_11_2607_ZH_CN_RELEASE_PROFILE.locale) reasons.push("NOTEPAD_LOCALE_UNSUPPORTED");
  return { ...observed, supportedEnvironment: reasons.length === 0, reasons };
}

/** No caller-supplied profile, environment switch or CLI flag can release a profile. */
export function selectNotepadProfile(platform: string, metadata: unknown): NotepadProfileSelection {
  const match = matchNotepadEnvironment(platform, metadata);
  const available = NOTEPAD_PROFILE_RELEASE_READY && match.supportedEnvironment;
  return { ...match, releaseReady: NOTEPAD_PROFILE_RELEASE_READY, available,
    reasons: [...match.reasons, ...(!NOTEPAD_PROFILE_RELEASE_READY ? ["NOTEPAD_PROFILE_RELEASE_PENDING"] : [])],
    ...(available ? { profile: JSON.parse(JSON.stringify(NOTEPAD_11_2607_ZH_CN_RELEASE_PROFILE)) } : {}),
  };
}

/** Read installed package/culture metadata only; never start Notepad or a UI helper. */
export function readNotepadInstalledMetadata(platform = process.platform, execute: MetadataExecutor = execFileSync as MetadataExecutor): NotepadInstalledMetadata | null {
  if (platform !== "win32") return null;
  try {
    const result = execute(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fileURLToPath(new URL("./notepad-profile-metadata.ps1", import.meta.url))],
      { encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 8192, stdio: ["ignore", "pipe", "pipe"] });
    if (typeof result !== "string" || Buffer.byteLength(result, "utf8") > 8192) return null;
    const value = JSON.parse(result.replace(/^\uFEFF/, "").trim());
    if (matchNotepadEnvironment("win32", value).reasons.includes("NOTEPAD_METADATA_UNAVAILABLE")) return null;
    return value;
  } catch { return null; }
}

/** Called lazily by the trusted service, never automatically by the generic driver. */
export function createServiceNotepadDriver(): SelectedNotepadDriver {
  const selection = selectNotepadProfile(process.platform, readNotepadInstalledMetadata());
  const driver = selection.profile ? createWindowsNotepadDriver({ profile: selection.profile }) : createWindowsNotepadDriver();
  return { driver, selection };
}
