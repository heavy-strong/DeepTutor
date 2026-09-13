/**
 * Which microphone and speaker the voice features use.
 *
 * A device choice belongs to the machine, not the account, so it lives in
 * this browser's localStorage. "" means the system default. Every mic
 * consumer (manual recorder, hands-free detector) asks `micConstraints()`
 * and every playback goes through `applySpeaker()`, so one picker steers
 * all of them.
 */

import { browserStorage } from "@/shared/storage";

export interface VoiceDevicePrefs {
  micId: string;
  speakerId: string;
}

export interface VoiceDeviceOption {
  deviceId: string;
  label: string;
}

export interface VoiceDeviceList {
  inputs: VoiceDeviceOption[];
  outputs: VoiceDeviceOption[];
  /** False until the mic permission is granted: labels come back empty. */
  labelsAvailable: boolean;
}

const MIC_KEY = "deeptutor.voice.micId";
const SPEAKER_KEY = "deeptutor.voice.speakerId";
const CHANGE_EVENT = "deeptutor:voice-devices";

export function readVoiceDevicePrefs(): VoiceDevicePrefs {
  return {
    micId: browserStorage.readRaw("local", MIC_KEY) ?? "",
    speakerId: browserStorage.readRaw("local", SPEAKER_KEY) ?? "",
  };
}

export function writeVoiceDevicePrefs(patch: Partial<VoiceDevicePrefs>): void {
  if (patch.micId !== undefined) {
    if (patch.micId) browserStorage.writeRaw("local", MIC_KEY, patch.micId);
    else browserStorage.removeRaw("local", MIC_KEY);
  }
  if (patch.speakerId !== undefined) {
    if (patch.speakerId) {
      browserStorage.writeRaw("local", SPEAKER_KEY, patch.speakerId);
    } else {
      browserStorage.removeRaw("local", SPEAKER_KEY);
    }
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(CHANGE_EVENT, { detail: readVoiceDevicePrefs() }),
    );
  }
}

/** Fires when the preference changes (this tab) or devices are (un)plugged. */
export function subscribeVoiceDevices(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(CHANGE_EVENT, listener);
  navigator.mediaDevices?.addEventListener?.("devicechange", listener);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    navigator.mediaDevices?.removeEventListener?.("devicechange", listener);
  };
}

/** getUserMedia audio constraints honouring the chosen mic. `ideal` rather
 *  than `exact`, so an unplugged device degrades to the default instead of
 *  failing the capture. */
export function micConstraints(
  extra: MediaTrackConstraints = {},
): MediaTrackConstraints {
  const { micId } = readVoiceDevicePrefs();
  return micId ? { ...extra, deviceId: { ideal: micId } } : extra;
}

type SinkCapable = HTMLMediaElement & {
  setSinkId?: (sinkId: string) => Promise<void>;
};

/** Output-device selection exists in Chromium and Firefox, not Safari. */
export function supportsSpeakerSelection(): boolean {
  return (
    typeof HTMLMediaElement !== "undefined" &&
    typeof (HTMLMediaElement.prototype as SinkCapable).setSinkId === "function"
  );
}

/** Route playback to the chosen speaker; a failure falls back to default. */
export async function applySpeaker(audio: HTMLMediaElement): Promise<void> {
  const { speakerId } = readVoiceDevicePrefs();
  const sink = audio as SinkCapable;
  if (!speakerId || typeof sink.setSinkId !== "function") return;
  try {
    await sink.setSinkId(speakerId);
  } catch {
    // Device gone or blocked — keep the default output rather than fail.
  }
}

function labelFor(device: MediaDeviceInfo, index: number, kind: string) {
  return device.label || `${kind} ${index + 1}`;
}

export async function listVoiceDevices(): Promise<VoiceDeviceList> {
  if (
    typeof navigator === "undefined" ||
    !navigator.mediaDevices?.enumerateDevices
  ) {
    return { inputs: [], outputs: [], labelsAvailable: false };
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices
    .filter((d) => d.kind === "audioinput")
    .map((d, i) => ({ deviceId: d.deviceId, label: labelFor(d, i, "Microphone") }));
  const outputs = devices
    .filter((d) => d.kind === "audiooutput")
    .map((d, i) => ({ deviceId: d.deviceId, label: labelFor(d, i, "Speaker") }));
  return {
    inputs,
    outputs,
    labelsAvailable: devices.some((d) => d.kind === "audioinput" && !!d.label),
  };
}

/** Ask for the mic once (and release it) so device labels become readable. */
export async function requestMicAccess(): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    return true;
  } catch {
    return false;
  }
}
