import { useState } from 'react';
import { Film, Image as ImageIcon } from 'lucide-react';
import type { MediaItem } from '../types';

interface MediaThumbnailProps {
  item: MediaItem;
  aspectClass?: string;
}

export function buildProxyUrl(
  mediaUrl: string,
  options?: { download?: boolean; filename?: string },
): string {
  const params = new URLSearchParams({ url: mediaUrl });
  if (options?.download) {
    params.set('download', '1');
  }
  if (options?.filename) {
    params.set('filename', options.filename);
  }
  return `/api/proxy?${params.toString()}`;
}

export function formatDuration(seconds?: number): string | null {
  if (!seconds || seconds <= 0) return null;
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export function MediaThumbnail({
  item,
  aspectClass = 'aspect-[4/3]',
}: MediaThumbnailProps) {
  const [hasError, setHasError] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const isVideoWithoutImageThumb =
    item.mediaType === 'video' &&
    item.thumbnailUrl === item.mediaUrl &&
    /\.mp4(\?|$)/i.test(item.thumbnailUrl);

  const durationText = formatDuration(item.durationSec);

  if (hasError || isVideoWithoutImageThumb) {
    return (
      <div
        className={`relative w-full ${aspectClass} bg-[#F4F4F5] dark:bg-[#18181B] flex flex-col items-center justify-center gap-2 text-[#71717A] dark:text-[#A1A1AA] overflow-hidden select-none`}
      >
        {item.mediaType === 'video' ? (
          <Film className="w-6 h-6 text-[#52525B] dark:text-[#A1A1AA]" aria-hidden="true" />
        ) : (
          <ImageIcon className="w-6 h-6 text-[#52525B] dark:text-[#A1A1AA]" aria-hidden="true" />
        )}
        <span className="text-xs font-mono text-[#52525B] dark:text-[#A1A1AA] px-3 text-center truncate max-w-full">
          {item.mediaType === 'video' ? 'Video Stream' : item.extension.toUpperCase()}
        </span>
        {durationText && (
          <span className="absolute bottom-2 right-2 px-1.5 py-0.5 text-[11px] font-mono tabular-nums text-white bg-black/75 rounded-xs">
            {durationText}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className={`relative w-full ${aspectClass} bg-[#F4F4F5] dark:bg-[#18181B] overflow-hidden`}>
      {!loaded && (
        <div
          className="absolute inset-0 bg-[#F4F4F5] dark:bg-[#18181B] animate-pulse"
          aria-hidden="true"
        />
      )}
      <img
        src={buildProxyUrl(item.thumbnailUrl)}
        alt={item.title || `${item.platform} media preview`}
        referrerPolicy="no-referrer"
        loading="lazy"
        decoding="async"
        onLoad={() => setLoaded(true)}
        onError={() => setHasError(true)}
        className={`w-full h-full object-cover transition-opacity duration-200 ${
          loaded ? 'opacity-100' : 'opacity-0'
        }`}
      />
      {item.mediaType === 'video' && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-black/80 via-black/35 to-transparent flex items-end justify-between px-2.5 pb-2">
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-white">
            <Film className="w-3.5 h-3.5" aria-hidden="true" />
            Video
          </span>
          {durationText && (
            <span className="text-[11px] font-mono tabular-nums text-white">
              {durationText}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
