/** Synthetic driver only: never imports a native transport or controls a real app. */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { notepadBufferToken, NotepadTaskError } from "../../packages/runtime/src/notepad-task.ts";
import type { NotepadBinding, NotepadDriver, NotepadEncoding, NotepadObservation } from "../../packages/runtime/src/notepad-task.ts";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export function fixtureNotepadBytes(text: string, encoding: NotepadEncoding): Buffer {
  return encoding === "utf16le-bom" ? Buffer.concat([Buffer.from([255, 254]), Buffer.from(text, "utf16le")])
    : encoding === "utf8-bom" ? Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(text)]) : Buffer.from(text);
}
export function fixtureNotepadText(file: string): string {
  const bytes = fs.readFileSync(file);
  return bytes[0] === 255 && bytes[1] === 254 ? bytes.subarray(2).toString("utf16le")
    : bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191 ? bytes.subarray(3).toString("utf8") : bytes.toString("utf8");
}
export class FixtureNotepadDriver implements NotepadDriver {
  readonly appId = "fixture-notepad";
  readonly sessionId = `fixture-${randomUUID()}`;
  readonly capabilities = { readBuffer: true, compareBeforeInput: true, saveCopy: true };
  revisionValue = "fixture-driver-v1";
  calls: string[] = [];
  state?: NotepadObservation;
  beforeOpen?: () => void | Promise<void>;
  beforeEdit?: () => void | Promise<void>;
  afterEdit?: () => void | Promise<void>;
  beforeSave?: () => void | Promise<void>;
  afterSave?: () => void | Promise<void>;
  onObserve?: () => void | Promise<void>;
  revision() { return this.revisionValue; }
  private checked(binding: NotepadBinding, token?: string): NotepadObservation {
    if (!this.state || Object.entries(binding).some(([key, value]) => this.state![key as keyof NotepadObservation] !== value)
      || token !== undefined && notepadBufferToken(this.state) !== token) throw new NotepadTaskError("DRIVER_PRECONDITION_FAILED", "Synthetic driver detected an intervening document change");
    return this.state;
  }
  async open(input: Parameters<NotepadDriver["open"]>[0]): Promise<NotepadObservation> {
    this.calls.push("open"); await this.beforeOpen?.();
    if (input.signal.aborted) throw new NotepadTaskError("CANCELLED", "Synthetic input cancelled");
    this.state = { appId: this.appId, driverSessionId: this.sessionId, windowId: "synthetic-window", documentId: randomUUID(), documentPath: input.sourcePath,
      windowTitle: "PRIVATE_WINDOW_TITLE_SENTINEL", text: fixtureNotepadText(input.sourcePath), modified: false, focused: true,
      evidence: { window: "driver-opaque", document: "driver-session-document", path: "explicit-open", buffer: "accessibility-text", bufferComplete: true } };
    return clone(this.state);
  }
  async observe(binding: NotepadBinding): Promise<NotepadObservation> {
    this.calls.push("observe"); await this.onObserve?.(); return clone(this.checked(binding));
  }
  async edit(input: Parameters<NotepadDriver["edit"]>[0]): Promise<NotepadObservation> {
    this.calls.push("edit"); await this.beforeEdit?.(); const current = this.checked(input.binding, input.expectedToken);
    if (input.signal.aborted) throw new NotepadTaskError("CANCELLED", "Synthetic input cancelled");
    current.text = input.replacementText; current.modified = true; await this.afterEdit?.(); return clone(current);
  }
  async saveCopy(input: Parameters<NotepadDriver["saveCopy"]>[0]): Promise<NotepadObservation> {
    this.calls.push("save-copy"); await this.beforeSave?.(); const current = this.checked(input.binding, input.expectedToken);
    if (input.signal.aborted) throw new NotepadTaskError("CANCELLED", "Synthetic input cancelled");
    fs.writeFileSync(input.copyPath, fixtureNotepadBytes(current.text, input.encoding), { flag: "wx" });
    current.documentPath = input.copyPath; current.modified = false; current.evidence.path = "save-copy-dialog";
    await this.afterSave?.(); return clone(current);
  }
}
