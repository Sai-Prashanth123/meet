"use client"

import React from "react"
import { Switch } from "./ui/switch"
import { FlaskConical, AlertCircle, Cloud, LogOut, User } from "lucide-react"
import { useConfig } from "@/contexts/ConfigContext"
import {
  BetaFeatureKey,
  BETA_FEATURE_NAMES,
  BETA_FEATURE_DESCRIPTIONS
} from "@/types/betaFeatures"
import { AutoMeetingDetectionSettings } from "./AutoMeetingDetectionSettings"
import { useAuth } from "@/contexts/AuthContext"

export function BetaSettings() {
  const { betaFeatures, toggleBetaFeature } = useConfig();
  const { token, user, signOut, signIn, signUp } = useAuth();
  const [cloudAuthMode, setCloudAuthMode] = React.useState<'login' | 'register'>('login');
  const [cloudEmail, setCloudEmail] = React.useState('');
  const [cloudPassword, setCloudPassword] = React.useState('');
  const [cloudError, setCloudError] = React.useState<string | null>(null);
  const [cloudLoading, setCloudLoading] = React.useState(false);

  async function handleCloudAuth(e: React.FormEvent) {
    e.preventDefault();
    setCloudError(null);
    setCloudLoading(true);
    try {
      if (cloudAuthMode === 'login') {
        await signIn(cloudEmail, cloudPassword);
      } else {
        await signUp(cloudEmail, cloudPassword);
      }
    } catch (err: unknown) {
      setCloudError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setCloudLoading(false);
    }
  }

  // Define feature order for display (allows custom ordering)
  const featureOrder: BetaFeatureKey[] = ['importAndRetranscribe', 'autoMeetingDetection', 'cloudMode'];

  return (
    <div className="space-y-6">
      {/* Yellow Warning Banner */}
      <div className="flex items-start gap-3 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
        <AlertCircle className="h-5 w-5 text-yellow-600 flex-shrink-0 mt-0.5" />
        <div className="text-sm text-yellow-800">
          <p className="font-medium">Beta Features</p>
          <p className="mt-1">
            These features are still being tested. You may encounter issues, and we appreciate your feedback.
          </p>
        </div>
      </div>

      {/* Dynamic Feature Toggles - Automatically renders all features */}
      {featureOrder.map((featureKey) => (
        <div
          key={featureKey}
          className="bg-white rounded-lg border border-gray-200 p-6 shadow-sm"
        >
          <div className="flex items-center justify-between">
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-2">
                <FlaskConical className="h-5 w-5 text-gray-600" />
                <h3 className="text-lg font-semibold text-gray-900">
                  {BETA_FEATURE_NAMES[featureKey]}
                </h3>
                <span className="px-2 py-0.5 text-xs font-medium bg-yellow-100 text-yellow-800 rounded-full">
                  BETA
                </span>
              </div>
              <p className="text-sm text-gray-600">
                {BETA_FEATURE_DESCRIPTIONS[featureKey]}
              </p>
            </div>

            <div className="ml-6">
              <Switch
                checked={betaFeatures[featureKey]}
                onCheckedChange={(checked) => toggleBetaFeature(featureKey, checked)}
              />
            </div>
          </div>

          {/* Render sub-settings for features that have them */}
          {featureKey === 'autoMeetingDetection' && betaFeatures.autoMeetingDetection && (
            <AutoMeetingDetectionSettings />
          )}
          {featureKey === 'cloudMode' && betaFeatures.cloudMode && (
            <div className="mt-4 border-t border-gray-100 pt-4">
              {token && user ? (
                <div className="flex items-center justify-between rounded-lg bg-green-50 border border-green-200 px-4 py-3">
                  <div className="flex items-center gap-2 text-sm text-green-800">
                    <User className="h-4 w-4" />
                    <span>Signed in as <strong>{user.email}</strong></span>
                  </div>
                  <button
                    onClick={signOut}
                    className="flex items-center gap-1 text-sm text-red-600 hover:text-red-700 font-medium"
                  >
                    <LogOut className="h-4 w-4" />
                    Sign out
                  </button>
                </div>
              ) : (
                <div className="rounded-lg border border-gray-200 overflow-hidden">
                  <div className="flex items-center gap-2 px-4 py-2 bg-gray-50 border-b border-gray-200">
                    <Cloud className="h-4 w-4 text-gray-500" />
                    <span className="text-sm font-medium text-gray-700">
                      {cloudAuthMode === 'login' ? 'Sign in to Meetily Cloud' : 'Create a Meetily Cloud account'}
                    </span>
                  </div>
                  <form onSubmit={handleCloudAuth} className="p-4 space-y-3">
                    <input
                      type="email"
                      required
                      placeholder="you@example.com"
                      value={cloudEmail}
                      onChange={(e) => setCloudEmail(e.target.value)}
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                    <input
                      type="password"
                      required
                      placeholder="••••••••"
                      value={cloudPassword}
                      onChange={(e) => setCloudPassword(e.target.value)}
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                    {cloudError && (
                      <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{cloudError}</p>
                    )}
                    <div className="flex items-center justify-between gap-3">
                      <button
                        type="submit"
                        disabled={cloudLoading}
                        className="flex-1 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                      >
                        {cloudLoading ? 'Please wait…' : cloudAuthMode === 'login' ? 'Sign in' : 'Create account'}
                      </button>
                      <button
                        type="button"
                        onClick={() => { setCloudAuthMode(cloudAuthMode === 'login' ? 'register' : 'login'); setCloudError(null); }}
                        className="text-sm text-primary hover:underline"
                      >
                        {cloudAuthMode === 'login' ? 'Register' : 'Sign in'}
                      </button>
                    </div>
                  </form>
                </div>
              )}
            </div>
          )}
        </div>
      ))}

      {/* Info Box */}
      <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
        <p className="text-sm text-blue-800">
          <strong>Note:</strong> When disabled, beta features will be hidden. Your existing meetings remain unaffected.
        </p>
      </div>
    </div>
  );
}
