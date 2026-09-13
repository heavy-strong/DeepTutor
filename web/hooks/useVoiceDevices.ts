"use client";

import { useCallback, useEffect, useState } from "react";

import {
  listVoiceDevices,
  readVoiceDevicePrefs,
  requestMicAccess,
  subscribeVoiceDevices,
  supportsSpeakerSelection,
  writeVoiceDevicePrefs,
  type VoiceDeviceList,
  type VoiceDevicePrefs,
} from "@/lib/voice-devices";

const EMPTY: VoiceDeviceList = { inputs: [], outputs: [], labelsAvailable: false };

/**
 * The browser's audio devices plus the chosen mic/speaker. Re-enumerates
 * when devices are plugged in or out and when another surface changes the
 * choice. ``label`` helpers resolve what is in use right now for display.
 */
export function useVoiceDevices() {
  const [devices, setDevices] = useState<VoiceDeviceList>(EMPTY);
  const [prefs, setPrefs] = useState<VoiceDevicePrefs>({ micId: "", speakerId: "" });
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setPrefs(readVoiceDevicePrefs());
    try {
      setDevices(await listVoiceDevices());
    } catch {
      setDevices(EMPTY);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return subscribeVoiceDevices(() => void refresh());
  }, [refresh]);

  const setMic = useCallback((micId: string) => {
    writeVoiceDevicePrefs({ micId });
  }, []);
  const setSpeaker = useCallback((speakerId: string) => {
    writeVoiceDevicePrefs({ speakerId });
  }, []);
  const unlockLabels = useCallback(async () => {
    if (await requestMicAccess()) await refresh();
  }, [refresh]);

  const micLabel =
    devices.inputs.find((d) => d.deviceId === prefs.micId)?.label ?? null;
  const speakerLabel =
    devices.outputs.find((d) => d.deviceId === prefs.speakerId)?.label ?? null;

  return {
    devices,
    prefs,
    loading,
    /** Label of the chosen mic, or null for the system default. */
    micLabel,
    /** Label of the chosen speaker, or null for the system default. */
    speakerLabel,
    speakerSelectable: supportsSpeakerSelection(),
    setMic,
    setSpeaker,
    unlockLabels,
    refresh,
  };
}
