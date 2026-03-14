import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { useConfig } from '@/contexts/ConfigContext';
import { recordingService } from '@/services/recordingService';
import { MeetingDetectedEvent, MeetingEndedEvent } from '@/types/meetingDetection';

/**
 * Listens for Tauri meeting-detected / meeting-ended events and optionally
 * auto-starts / auto-stops recording based on the user's DetectorConfig.
 *
 * Manual-override guard:
 *   autoStartedMeetingNameRef is null  → recording was started manually
 *   autoStartedMeetingNameRef is set   → recording was auto-started by this hook
 *   meeting-ended auto-stop only fires when the ref is non-null.
 */
export function useAutoMeetingDetection(
  isRecording: boolean,
  setIsRecording: (v: boolean) => void
) {
  const { betaFeatures, detectorConfig, selectedDevices } = useConfig();
  const autoStartedMeetingNameRef = useRef<string | null>(null);
  const isRecordingRef = useRef(isRecording);

  // Keep ref in sync without re-running the effect
  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  // Reset auto-start ref when user manually starts recording
  useEffect(() => {
    const handleManualStart = () => {
      autoStartedMeetingNameRef.current = null;
    };
    window.addEventListener('manual-recording-started', handleManualStart);
    return () => window.removeEventListener('manual-recording-started', handleManualStart);
  }, []);

  useEffect(() => {
    if (!betaFeatures.autoMeetingDetection) return;

    let unlistenDetected: (() => void) | undefined;
    let unlistenEnded: (() => void) | undefined;

    const setup = async () => {
      unlistenDetected = await listen<MeetingDetectedEvent>(
        'meeting-detected',
        async (event) => {
          if (isRecordingRef.current) return; // Already recording — skip

          const { suggested_meeting_name } = event.payload;

          try {
            await recordingService.startRecordingWithDevices(
              selectedDevices?.micDevice ?? null,
              selectedDevices?.systemDevice ?? null,
              suggested_meeting_name
            );
            setIsRecording(true);
            autoStartedMeetingNameRef.current = suggested_meeting_name;
            toast.success('Meeting detected — Recording started', {
              description: suggested_meeting_name,
              duration: 5000,
            });
          } catch (error) {
            console.error('[useAutoMeetingDetection] Failed to auto-start recording:', error);
            toast.error('Failed to auto-start recording', {
              description: error instanceof Error ? error.message : 'Unknown error',
              duration: 5000,
            });
            autoStartedMeetingNameRef.current = null;
          }
        }
      );

      unlistenEnded = await listen<MeetingEndedEvent>('meeting-ended', async () => {
        if (!detectorConfig.auto_stop_recording) return;
        if (!autoStartedMeetingNameRef.current) return; // Manual-override guard

        autoStartedMeetingNameRef.current = null;
        toast.info('Meeting ended — Stopping recording', { duration: 4000 });
        window.dispatchEvent(new CustomEvent('auto-stop-recording'));
      });
    };

    setup().catch((err) =>
      console.error('[useAutoMeetingDetection] Failed to set up listeners:', err)
    );

    return () => {
      unlistenDetected?.();
      unlistenEnded?.();
    };
  }, [
    betaFeatures.autoMeetingDetection,
    detectorConfig.auto_start_recording,
    detectorConfig.auto_stop_recording,
    selectedDevices,
    setIsRecording,
  ]);
}
