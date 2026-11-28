import { useState } from 'react';
import { Check, Copy, Download, Share2, X } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

export function PWAInstallButton() {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);

  if (isInstalled) {
    return null;
  }

  const shortcutTemplate =
    typeof window !== 'undefined' ? `${window.location.origin}/?url=` : '/?url=';

  async function handleCopyShortcutUrl() {
    try {
      await navigator.clipboard.writeText(shortcutTemplate);
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 2000);
    } catch {
      // Clipboard blocked in sandbox
    }
  }

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={() => void install()}
        title="Install PullDeck app for 1-tap Share-to-PullDeck on mobile & desktop"
        className="min-h-[40px] sm:min-h-0 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-white bg-[#1D4ED8] dark:bg-[#2563EB] hover:bg-[#1E40AF] dark:hover:bg-[#3B82F6] rounded-lg transition-colors whitespace-nowrap shrink-0"
      >
        <Download className="w-4 h-4 sm:w-3.5 sm:h-3.5" aria-hidden="true" />
        <span>Install</span>
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIOSGuide(true)}
          aria-label="Install PullDeck on iOS"
          className="min-h-[40px] sm:min-h-0 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-[#52525B] dark:text-[#D4D4D8] bg-[#F4F4F5] dark:bg-[#18181B] hover:text-[#09090B] dark:hover:text-[#FAFAFA] border border-[#E4E4E7] dark:border-[#27272A] rounded-lg transition-colors whitespace-nowrap shrink-0"
        >
          <Share2 className="w-4 h-4 sm:w-3.5 sm:h-3.5" aria-hidden="true" />
          <span>Install</span>
        </button>

        {showIOSGuide && (
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="ios-install-title"
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-xs sm:p-4"
            onClick={() => setShowIOSGuide(false)}
          >
            <div
              className="w-full sm:max-w-sm rounded-t-2xl sm:rounded-xl bg-white dark:bg-[#111114] border-t sm:border border-[#E4E4E7] dark:border-[#27272A] p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] sm:pb-5 shadow-xl space-y-4"
              onClick={(e) => e.stopPropagation()}
            >
              <div
                aria-hidden="true"
                className="sm:hidden w-10 h-1 rounded-full bg-[#D4D4D8] dark:bg-[#3F3F46] mx-auto -mt-1 mb-1"
              />
              <div className="flex items-center justify-between gap-3">
                <h3
                  id="ios-install-title"
                  className="text-sm font-semibold text-[#09090B] dark:text-[#FAFAFA]"
                >
                  Install &amp; Auto-Share on iPhone / iPad
                </h3>
                <button
                  type="button"
                  onClick={() => setShowIOSGuide(false)}
                  aria-label="Close install guide"
                  className="min-w-[40px] min-h-[40px] -mr-2 inline-flex items-center justify-center text-[#71717A] dark:text-[#A1A1AA] hover:text-[#09090B] dark:hover:text-[#FAFAFA] rounded-lg"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="space-y-3 text-xs text-[#52525B] dark:text-[#A1A1AA] leading-relaxed">
                <div>
                  <p className="font-medium text-[#09090B] dark:text-[#FAFAFA] mb-1">
                    Add to Home Screen
                  </p>
                  <ol className="list-decimal list-inside space-y-1">
                    <li>Tap the Share icon in Safari.</li>
                    <li>Scroll down and tap Add to Home Screen.</li>
                  </ol>
                </div>

                <div className="pt-2.5 border-t border-[#E4E4E7] dark:border-[#27272A]">
                  <p className="font-medium text-[#09090B] dark:text-[#FAFAFA] mb-1">
                    1-Tap iOS Share Sheet Shortcut
                  </p>
                  <p className="mb-2">
                    Create an Apple Shortcut that accepts URLs from the Share Sheet and opens this prefix + the shared link to auto-fetch immediately:
                  </p>
                  <div className="flex items-center gap-1.5">
                    <code className="flex-1 px-2.5 py-2 rounded-md bg-[#F4F4F5] dark:bg-[#18181B] border border-[#E4E4E7] dark:border-[#27272A] font-mono text-[11px] text-[#09090B] dark:text-[#FAFAFA] truncate">
                      {shortcutTemplate}
                    </code>
                    <button
                      type="button"
                      onClick={() => void handleCopyShortcutUrl()}
                      className="h-10 sm:h-8 px-3 sm:px-2.5 inline-flex items-center gap-1 text-xs font-medium rounded-md border border-[#E4E4E7] dark:border-[#27272A] bg-[#FAFAFA] dark:bg-[#18181B] text-[#09090B] dark:text-[#FAFAFA] hover:border-[#1D4ED8] dark:hover:border-[#3B82F6] shrink-0"
                    >
                      {copiedUrl ? (
                        <Check className="w-3.5 h-3.5 text-[#15803D] dark:text-[#4ADE80]" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                      <span>{copiedUrl ? 'Copied' : 'Copy'}</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
}
