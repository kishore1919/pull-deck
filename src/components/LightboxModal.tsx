import { useEffect } from 'react';
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

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Preview ${item.title}`}
      className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4 sm:p-6"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-[#111114] border border-[#E4E4E7] dark:border-[#27272A] rounded-xl max-w-4xl w-full max-h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="px-5 py-3.5 border-b border-[#E4E4E7] dark:border-[#27272A] flex items-center justify-between gap-4">
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

          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs font-mono tabular-nums text-[#71717A] dark:text-[#A1A1AA] mr-2">
              {activeIndex + 1} / {items.length}
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close preview"
              className="p-2 text-[#52525B] dark:text-[#A1A1AA] hover:text-[#09090B] dark:hover:text-[#FAFAFA] rounded-lg hover:bg-[#F4F4F5] dark:hover:bg-[#18181B] transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Media Viewport */}
        <div className="relative flex-1 bg-[#09090B] flex items-center justify-center min-h-[320px] max-h-[65vh] overflow-hidden">
          {item.mediaType === 'video' ? (
            <video
              key={item.id}
              src={proxiedMedia}
              controls
              playsInline
              className="max-h-[65vh] max-w-full object-contain"
            />
          ) : (
            <img
              key={item.id}
              src={proxiedMedia}
              alt={item.title}
              referrerPolicy="no-referrer"
              className="max-h-[65vh] max-w-full object-contain"
            />
          )}

          {activeIndex > 0 && (
            <button
              type="button"
              onClick={() => onNavigate(activeIndex - 1)}
              aria-label="Previous media item"
              className="absolute left-3 top-1/2 -translate-y-1/2 w-10 h-10 rounded-lg bg-white/90 dark:bg-[#18181B]/90 text-[#09090B] dark:text-[#FAFAFA] hover:bg-white dark:hover:bg-[#27272A] flex items-center justify-center transition-colors"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
          )}

          {activeIndex < items.length - 1 && (
            <button
              type="button"
              onClick={() => onNavigate(activeIndex + 1)}
              aria-label="Next media item"
              className="absolute right-3 top-1/2 -translate-y-1/2 w-10 h-10 rounded-lg bg-white/90 dark:bg-[#18181B]/90 text-[#09090B] dark:text-[#FAFAFA] hover:bg-white dark:hover:bg-[#27272A] flex items-center justify-center transition-colors"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* Modal Footer Actions */}
        <div className="px-5 py-3.5 border-t border-[#E4E4E7] dark:border-[#27272A] flex flex-wrap items-center justify-between gap-3 bg-white dark:bg-[#111114]">
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => onToggleSelect(item.id)}
              className="inline-flex items-center gap-2 text-xs font-medium text-[#09090B] dark:text-[#FAFAFA] hover:text-[#1D4ED8] dark:hover:text-[#60A5FA] transition-colors"
            >
              <span
                className={`w-4 h-4 rounded-xs border flex items-center justify-center ${
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
                className="inline-flex items-center gap-1.5 text-xs font-medium text-[#52525B] dark:text-[#A1A1AA] hover:text-[#09090B] dark:hover:text-[#FAFAFA] transition-colors"
              >
                <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Original Source</span>
              </a>
            )}
          </div>

          <button
            type="button"
            onClick={() => onDownloadSingle(item)}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-[#1D4ED8] dark:bg-[#2563EB] hover:bg-[#1E40AF] dark:hover:bg-[#3B82F6] rounded-lg transition-colors whitespace-nowrap"
          >
            <Download className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Download {item.extension.toUpperCase()}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
