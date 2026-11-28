import { useEffect, useRef } from 'react';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  X,
} from 'lucide-react';
import type { MediaItem } from '../types';
import { buildProxyUrl } from './MediaThumbnail';

interface LightboxModalProps {
  items: MediaItem[];
  activeIndex: number;
  selectedIds: Set<string>;
  onClose: () => void;
  onNavigate: (nextIndex: number) => void;
  onToggleSelect: (id: string) => void;
  onDownloadSingle: (item: MediaItem) => void;
}

export function LightboxModal({
  items,
  activeIndex,
  selectedIds,
  onClose,
  onNavigate,
  onToggleSelect,
  onDownloadSingle,
}: LightboxModalProps) {
  const item = items[activeIndex];
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft' && activeIndex > 0) {
        onNavigate(activeIndex - 1);
      }
      if (e.key === 'ArrowRight' && activeIndex < items.length - 1) {
        onNavigate(activeIndex + 1);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeIndex, items.length, onClose, onNavigate]);

  if (!item) return null;

  const isSelected = selectedIds.has(item.id);
  const proxiedMedia = buildProxyUrl(item.mediaUrl);
  const platformLabel =
    item.platform === 'redgifs'
      ? 'RedGIFs'
      : item.platform === 'instagram'
        ? 'Instagram'
        : 'Reddit';

  function handleTouchStart(e: React.TouchEvent<HTMLDivElement>) {
    const touch = e.touches[0];
    if (!touch) return;
    touchStartRef.current = { x: touch.clientX, y: touch.clientY };
  }

  function handleTouchEnd(e: React.TouchEvent<HTMLDivElement>) {
    const start = touchStartRef.current;
    touchStartRef.current = null;
    const touch = e.changedTouches[0];
    if (!start || !touch) return;

    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.2) return;

    if (dx < 0 && activeIndex < items.length - 1) {
      onNavigate(activeIndex + 1);
    } else if (dx > 0 && activeIndex > 0) {
      onNavigate(activeIndex - 1);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Preview ${item.title}`}
      className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center p-0 sm:p-6"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-[#111114] sm:border border-[#E4E4E7] dark:border-[#27272A] rounded-none sm:rounded-xl max-w-4xl w-full h-[100dvh] sm:h-auto sm:max-h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="px-4 sm:px-5 pt-[calc(0.75rem+env(safe-area-inset-top))] sm:pt-3.5 pb-3 sm:pb-3.5 border-b border-[#E4E4E7] dark:border-[#27272A] flex items-center justify-between gap-3 sm:gap-4 shrink-0">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-[#09090B] dark:text-[#FAFAFA] truncate">
              {item.title}
            </h3>
            <p className="text-xs text-[#71717A] dark:text-[#A1A1AA] font-mono tabular-nums truncate">
              {platformLabel}
              {' · '}
              {item.sourceContainer}
              {' · '}
              {item.filename}
              {item.width && item.height ? ` · ${item.width}×${item.height}` : ''}
            </p>
          </div>

          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            <span className="text-xs font-mono tabular-nums text-[#71717A] dark:text-[#A1A1AA] mr-1 sm:mr-2">
              {activeIndex + 1} / {items.length}
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close preview"
              className="min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0 -mr-2 sm:mr-0 inline-flex items-center justify-center p-2 text-[#52525B] dark:text-[#A1A1AA] hover:text-[#09090B] dark:hover:text-[#FAFAFA] rounded-lg hover:bg-[#F4F4F5] dark:hover:bg-[#18181B] transition-colors"
            >
              <X className="w-5 h-5 sm:w-4 sm:h-4" />
            </button>
          </div>
        </div>

        {/* Media Viewport (touch swipe enabled on mobile) */}
        <div
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
          className="relative flex-1 bg-[#09090B] flex items-center justify-center min-h-0 sm:min-h-[320px] sm:max-h-[65vh] overflow-hidden"
        >
          {item.mediaType === 'video' ? (
            <video
              key={item.id}
              src={proxiedMedia}
              controls
              playsInline
              className="max-h-full sm:max-h-[65vh] max-w-full object-contain"
            />
          ) : (
            <img
              key={item.id}
              src={proxiedMedia}
              alt={item.title}
              referrerPolicy="no-referrer"
              className="max-h-full sm:max-h-[65vh] max-w-full object-contain select-none"
            />
          )}

          {activeIndex > 0 && (
            <button
              type="button"
              onClick={() => onNavigate(activeIndex - 1)}
              aria-label="Previous media item"
              className="absolute left-2 sm:left-3 top-1/2 -translate-y-1/2 w-11 h-11 sm:w-10 sm:h-10 rounded-lg bg-white/85 dark:bg-[#18181B]/85 text-[#09090B] dark:text-[#FAFAFA] hover:bg-white dark:hover:bg-[#27272A] flex items-center justify-center transition-colors"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
          )}

          {activeIndex < items.length - 1 && (
            <button
              type="button"
              onClick={() => onNavigate(activeIndex + 1)}
              aria-label="Next media item"
              className="absolute right-2 sm:right-3 top-1/2 -translate-y-1/2 w-11 h-11 sm:w-10 sm:h-10 rounded-lg bg-white/85 dark:bg-[#18181B]/85 text-[#09090B] dark:text-[#FAFAFA] hover:bg-white dark:hover:bg-[#27272A] flex items-center justify-center transition-colors"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* Modal Footer Actions */}
        <div className="px-4 sm:px-5 pt-3 sm:py-3.5 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:pb-3.5 border-t border-[#E4E4E7] dark:border-[#27272A] flex flex-col sm:flex-row sm:flex-wrap sm:items-center justify-between gap-2.5 sm:gap-3 bg-white dark:bg-[#111114] shrink-0">
          <div className="flex items-center justify-between sm:justify-start gap-4">
            <button
              type="button"
              onClick={() => onToggleSelect(item.id)}
              className="min-h-[40px] sm:min-h-0 inline-flex items-center gap-2 text-xs font-medium text-[#09090B] dark:text-[#FAFAFA] hover:text-[#1D4ED8] dark:hover:text-[#60A5FA] transition-colors"
            >
              <span
                className={`w-5 h-5 sm:w-4 sm:h-4 rounded-xs border flex items-center justify-center ${
                  isSelected
                    ? 'bg-[#1D4ED8] dark:bg-[#2563EB] border-[#1D4ED8] dark:border-[#2563EB] text-white'
                    : 'border-[#D4D4D8] dark:border-[#3F3F46] text-transparent'
                }`}
              >
                <Check className="w-3 h-3" strokeWidth={2.5} />
              </span>
              <span>{isSelected ? 'Included in ZIP' : 'Add to ZIP bundle'}</span>
            </button>

            {/^https?:\/\//i.test(item.sourceUrl) && (
              <a
                href={item.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="min-h-[40px] sm:min-h-0 inline-flex items-center gap-1.5 text-xs font-medium text-[#52525B] dark:text-[#A1A1AA] hover:text-[#09090B] dark:hover:text-[#FAFAFA] transition-colors"
              >
                <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Original Source</span>
              </a>
            )}
          </div>

          <button
            type="button"
            onClick={() => onDownloadSingle(item)}
            className="w-full sm:w-auto h-11 sm:h-9 inline-flex items-center justify-center gap-2 px-4 text-xs font-medium text-white bg-[#1D4ED8] dark:bg-[#2563EB] hover:bg-[#1E40AF] dark:hover:bg-[#3B82F6] rounded-lg transition-all active:scale-[0.99] whitespace-nowrap"
          >
            <Download className="w-4 h-4 sm:w-3.5 sm:h-3.5" aria-hidden="true" />
            <span>Download {item.extension.toUpperCase()}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
