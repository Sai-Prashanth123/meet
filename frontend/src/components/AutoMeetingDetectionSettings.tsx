'use client';

import { Switch } from './ui/switch';
import { Monitor, Video, Users } from 'lucide-react';
import { useConfig } from '@/contexts/ConfigContext';
import { DetectorConfig } from '@/types/meetingDetection';

export function AutoMeetingDetectionSettings() {
  const { detectorConfig, updateDetectorConfig } = useConfig();

  const update = (patch: Partial<DetectorConfig>) => {
    updateDetectorConfig({ ...detectorConfig, ...patch });
  };

  return (
    <div className="mt-4 ml-6 space-y-4 border-l-2 border-gray-100 pl-4">
      {/* Windows-only notice */}
      <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-800">
        Auto-meeting detection is currently available on <strong>Windows only</strong>. On other
        platforms all detectors return no results.
      </div>

      {/* Master enable */}
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-gray-700">Enable Auto-Detection</span>
        <Switch
          checked={detectorConfig.enabled}
          onCheckedChange={(checked) => update({ enabled: checked })}
        />
      </div>

      {detectorConfig.enabled && (
        <div className="space-y-4">
          {/* Per-app toggles */}
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
            Detect these apps
          </p>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-gray-700">
              <Video className="h-4 w-4 text-blue-500" />
              Zoom
            </div>
            <Switch
              checked={detectorConfig.detect_zoom}
              onCheckedChange={(checked) => update({ detect_zoom: checked })}
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-gray-700">
              <Users className="h-4 w-4 text-purple-500" />
              Microsoft Teams
            </div>
            <Switch
              checked={detectorConfig.detect_teams}
              onCheckedChange={(checked) => update({ detect_teams: checked })}
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-gray-700">
              <Monitor className="h-4 w-4 text-green-500" />
              Google Meet
            </div>
            <Switch
              checked={detectorConfig.detect_google_meet}
              onCheckedChange={(checked) => update({ detect_google_meet: checked })}
            />
          </div>

          {/* Recording automation */}
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 pt-2">
            Recording automation
          </p>

          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-700">Auto-start recording</p>
              <p className="text-xs text-gray-500">
                Starts recording when a meeting is detected
              </p>
            </div>
            <Switch
              checked={detectorConfig.auto_start_recording}
              onCheckedChange={(checked) => update({ auto_start_recording: checked })}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-700">Auto-stop recording</p>
              <p className="text-xs text-gray-500">
                Stops recording when the meeting ends (only if auto-started)
              </p>
            </div>
            <Switch
              checked={detectorConfig.auto_stop_recording}
              onCheckedChange={(checked) => update({ auto_stop_recording: checked })}
            />
          </div>

          {detectorConfig.auto_stop_recording && (
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <p className="text-sm text-gray-700">Grace period</p>
                <span className="text-sm font-medium text-gray-900">
                  {detectorConfig.stop_grace_period_secs}s
                </span>
              </div>
              <input
                type="range"
                min={10}
                max={120}
                step={10}
                value={detectorConfig.stop_grace_period_secs}
                onChange={(e) =>
                  update({ stop_grace_period_secs: Number(e.target.value) })
                }
                className="w-full accent-blue-600"
              />
              <div className="flex justify-between text-xs text-gray-400">
                <span>10s</span>
                <span>120s</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
