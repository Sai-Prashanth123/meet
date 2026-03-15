'use client'

import { useState, useEffect, useCallback } from 'react'
import { listen, UnlistenFn } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { toast, Toaster } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { RecordingStateProvider } from '@/contexts/RecordingStateContext'
import { OllamaDownloadProvider } from '@/contexts/OllamaDownloadContext'
import { TranscriptProvider } from '@/contexts/TranscriptContext'
import { ConfigProvider, useConfig } from '@/contexts/ConfigContext'
import { OnboardingProvider } from '@/contexts/OnboardingContext'
import { OnboardingFlow } from '@/components/onboarding'
import { DownloadProgressToastProvider } from '@/components/shared/DownloadProgressToast'
import { UpdateCheckProvider } from '@/components/UpdateCheckProvider'
import { RecordingPostProcessingProvider } from '@/contexts/RecordingPostProcessingProvider'
import { ImportAudioDialog, ImportDropOverlay } from '@/components/ImportAudio'
import { ImportDialogProvider } from '@/contexts/ImportDialogContext'
import { AuthProvider } from '@/contexts/AuthContext'
import { SidebarProvider } from '@/components/Sidebar/SidebarProvider'
import Sidebar from '@/components/Sidebar'
import MainContent from '@/components/MainContent'
import AnalyticsProvider from '@/components/AnalyticsProvider'
import { loadBetaFeatures } from '@/types/betaFeatures'
import { isAudioExtension, getAudioFormatsDisplayList } from '@/constants/audioFormats'

// Module-level component — stable reference across re-renders so React never
// sees a new function type on re-render (avoids unmount/remount).
function ConditionalImportDialog({
  showImportDialog,
  handleImportDialogClose,
  importFilePath,
}: {
  showImportDialog: boolean;
  handleImportDialogClose: (open: boolean) => void;
  importFilePath: string | null;
}) {
  const { betaFeatures } = useConfig();
  if (!betaFeatures.importAndRetranscribe) return null;
  return (
    <ImportAudioDialog
      open={showImportDialog}
      onOpenChange={handleImportDialogClose}
      preselectedFile={importFilePath}
    />
  );
}

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [showDropOverlay, setShowDropOverlay] = useState(false)
  const [showImportDialog, setShowImportDialog] = useState(false)
  const [importFilePath, setImportFilePath] = useState<string | null>(null)

  useEffect(() => {
    invoke<{ completed: boolean } | null>('get_onboarding_status')
      .then((status) => {
        if (!(status?.completed ?? false)) {
          setShowOnboarding(true)
        }
      })
      .catch(() => setShowOnboarding(true))
  }, [])

  // Disable context menu in production
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') {
      const handleContextMenu = (e: MouseEvent) => e.preventDefault()
      document.addEventListener('contextmenu', handleContextMenu)
      return () => document.removeEventListener('contextmenu', handleContextMenu)
    }
  }, [])

  useEffect(() => {
    const unlisten = listen('request-recording-toggle', () => {
      if (showOnboarding) {
        toast.error('Please complete setup first', {
          description: 'You need to finish onboarding before you can start recording.',
        })
      } else {
        window.dispatchEvent(new CustomEvent('start-recording-from-sidebar'))
      }
    })
    return () => { unlisten.then(fn => fn()) }
  }, [showOnboarding])

  const handleFileDrop = useCallback((paths: string[]) => {
    const betaFeatures = loadBetaFeatures()
    if (!betaFeatures.importAndRetranscribe) {
      toast.error('Beta feature disabled', {
        description: 'Enable "Import Audio & Retranscribe" in Settings > Beta to use this feature.',
      })
      return
    }
    const audioFile = paths.find(p => {
      const ext = p.split('.').pop()?.toLowerCase()
      return !!ext && isAudioExtension(ext)
    })
    if (audioFile) {
      setImportFilePath(audioFile)
      setShowImportDialog(true)
    } else if (paths.length > 0) {
      toast.error('Please drop an audio file', {
        description: `Supported formats: ${getAudioFormatsDisplayList()}`,
      })
    }
  }, [])

  useEffect(() => {
    if (showOnboarding) return
    const unlisteners: UnlistenFn[] = []
    const cleanedUpRef = { current: false }

    const setupListeners = async () => {
      const unlistenDragEnter = await listen('tauri://drag-enter', () => {
        if (loadBetaFeatures().importAndRetranscribe) setShowDropOverlay(true)
      })
      if (cleanedUpRef.current) { unlistenDragEnter(); return }
      unlisteners.push(unlistenDragEnter)

      const unlistenDragLeave = await listen('tauri://drag-leave', () => setShowDropOverlay(false))
      if (cleanedUpRef.current) { unlistenDragLeave(); unlisteners.forEach(u => u()); return }
      unlisteners.push(unlistenDragLeave)

      const unlistenDrop = await listen<{ paths: string[] }>('tauri://drag-drop', (event) => {
        setShowDropOverlay(false)
        handleFileDrop(event.payload.paths)
      })
      if (cleanedUpRef.current) { unlistenDrop(); unlisteners.forEach(u => u()); return }
      unlisteners.push(unlistenDrop)
    }

    setupListeners()
    return () => {
      cleanedUpRef.current = true
      unlisteners.forEach(u => u())
    }
  }, [showOnboarding, handleFileDrop])

  const handleImportDialogClose = useCallback((open: boolean) => {
    setShowImportDialog(open)
    if (!open) setImportFilePath(null)
  }, [])

  const handleOpenImportDialog = useCallback((filePath?: string | null) => {
    setImportFilePath(filePath ?? null)
    setShowImportDialog(true)
  }, [])

  const handleOnboardingComplete = () => {
    setShowOnboarding(false)
    window.location.reload()
  }

  return (
    <AnalyticsProvider>
      <AuthProvider>
        <RecordingStateProvider>
          <TranscriptProvider>
            <ConfigProvider>
              <OllamaDownloadProvider>
                <OnboardingProvider>
                  <UpdateCheckProvider>
                    <SidebarProvider>
                      <TooltipProvider>
                        <RecordingPostProcessingProvider>
                          <ImportDialogProvider onOpen={handleOpenImportDialog}>
                            <DownloadProgressToastProvider />
                            {showOnboarding ? (
                              <OnboardingFlow onComplete={handleOnboardingComplete} />
                            ) : (
                              <div className="flex">
                                <Sidebar />
                                <MainContent>{children}</MainContent>
                              </div>
                            )}
                            <ImportDropOverlay visible={showDropOverlay} />
                            <ConditionalImportDialog
                              showImportDialog={showImportDialog}
                              handleImportDialogClose={handleImportDialogClose}
                              importFilePath={importFilePath}
                            />
                            <Toaster position="bottom-center" richColors closeButton />
                          </ImportDialogProvider>
                        </RecordingPostProcessingProvider>
                      </TooltipProvider>
                    </SidebarProvider>
                  </UpdateCheckProvider>
                </OnboardingProvider>
              </OllamaDownloadProvider>
            </ConfigProvider>
          </TranscriptProvider>
        </RecordingStateProvider>
      </AuthProvider>
    </AnalyticsProvider>
  )
}
