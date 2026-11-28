import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  FileText,
  LayoutGrid,
  List,
  Loader2,
  Lock,
  RotateCw,
  Search,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import type {
  DuplicateAnnotation,
  DuplicateMatchReason,
  ExtractionJob,
  MediaItem,
  Platform,
  ZipPartDownloadItem,
} from '../types';
import { MediaThumbnail } from './MediaThumbnail';

export type MediaTypeFilter =
  | 'all'
  | 'image'
  | 'video'
  | 'reel'
  | 'dp'
  | 'highlight'
  | 'story';

function isIgDp(item: MediaItem): boolean {
  return item.igCategory === 'dp' || item.contentType === 'ig_dp';
}

function isIgHighlight(item: MediaItem): boolean {
  return item.igCategory === 'highlight' || item.contentType === 'ig_highlight';
}

function isIgStory(item: MediaItem): boolean {
  return item.igCategory === 'story' || item.contentType === 'ig_story';
}

function isIgReel(item: MediaItem): boolean {
  return item.igCategory === 'reel' || item.contentType === 'ig_reel';
}

function isIgPhoto(item: MediaItem): boolean {
  return (
    item.mediaType === 'image' &&
    !isIgDp(item) &&
    !isIgHighlight(item) &&
    !isIgStory(item) &&
    !isIgReel(item)
  );
}

function isIgFeedVideo(item: MediaItem): boolean {
  return (
    item.mediaType === 'video' &&
    !isIgReel(item) &&
    !isIgStory(item) &&
    !isIgHighlight(item)
  );
}

const PAGE_RENDER_SIZE = 60;

function formatShortDate(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatDuplicateReason(reason?: DuplicateMatchReason): string {
  if (reason === 'visual') return 'Visual match';
  if (reason === 'title') return 'Same title';
  return 'Exact media';
}

interface StagingDeckProps {
  platform: Platform;
  items: MediaItem[];
  jobs: ExtractionJob[];
  selectedIds: Set<string>;
  typeFilter: MediaTypeFilter;
  onTypeFilterChange: (filter: MediaTypeFilter) => void;
  searchQuery: string;
  onSearchQueryChange: (q: string) => void;
  viewMode: 'grid' | 'table';
  onViewModeChange: (view: 'grid' | 'table') => void;
  isExtracting: boolean;
  loadingMoreJobUrl: string | null;
  autoLoadingJobUrl: string | null;
  isBundlingZip: boolean;
  zipProgressLabel: string | null;
  zipPartCount: number;
  zipParts?: ZipPartDownloadItem[];
  onSaveZipPart?: (partNumber: number) => void;
  onRetryZipPart?: (partNumber: number) => void;
  onStopZip?: () => void;
  onDismissZipParts?: () => void;
  selectedCount: number;
  duplicateAnnotations?: Map<string, DuplicateAnnotation>;
  duplicateCount?: number;
  showDuplicates?: boolean;
  onToggleShowDuplicates?: () => void;
  visualScanProgress?: { scanned: number; total: number } | null;
  onToggleSelect: (id: string) => void;
  onSelectVisible: (ids: string[]) => void;
  onDeselectPlatform: () => void;
  onClearPlatform: () => void;
  onPreviewItem: (item: MediaItem) => void;
  onDownloadSingle: (item: MediaItem) => void;
  onDownloadZip: () => void;
  onExportUrls: () => void;
  onRetryJob: (url: string) => void;
  onLoadMore: (job: ExtractionJob) => void;
  onLoadAll: (job: ExtractionJob) => void;
  onStopLoadAll: () => void;
  hasInstagramSession?: boolean;
}

function formatByteSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatContentLabel(item: MediaItem): string {
  if (item.platform === 'instagram') {
    if (isIgDp(item)) return 'HD DP';
    if (isIgHighlight(item)) return 'Highlight Cover';
    if (isIgStory(item)) return 'Story';
    if (isIgReel(item)) return 'Reel';
    if (item.groupSize > 1) {
      return `Slide ${item.indexInGroup}/${item.groupSize}`;
    }
    return item.mediaType === 'video' ? 'Video' : 'Photo';
  }
  if (item.platform === 'redgifs') {
    return 'HD MP4';
  }
  return item.groupSize > 1
    ? `Gallery ${item.indexInGroup}/${item.groupSize}`
    : item.mediaType === 'video'
      ? 'Video'
      : 'Image';
}

export function StagingDeck({
  platform,
  items,
  jobs,
  selectedIds,
  typeFilter,
  onTypeFilterChange,
  searchQuery,
  onSearchQueryChange,
  viewMode,
  onViewModeChange,
  isExtracting,
  loadingMoreJobUrl,
  autoLoadingJobUrl,
  isBundlingZip,
  zipProgressLabel,
  zipPartCount,
  zipParts = [],
  onSaveZipPart,
  onRetryZipPart,
  onStopZip,
  onDismissZipParts,
  selectedCount,
  duplicateAnnotations,
  duplicateCount = 0,
  showDuplicates = false,
  onToggleShowDuplicates,
  visualScanProgress,
  onToggleSelect,
  onSelectVisible,
  onDeselectPlatform,
  onClearPlatform,
  onPreviewItem,
  onDownloadSingle,
  onDownloadZip,
  onExportUrls,
  onRetryJob,
  onLoadMore,
  onLoadAll,
  onStopLoadAll,
  hasInstagramSession = false,
}: StagingDeckProps) {
  const [renderPage, setRenderPage] = useState(1);

  const normalizedQuery = searchQuery.trim().toLowerCase();

  const filteredItems = items.filter((item) => {
    if (platform === 'instagram') {
      if (typeFilter === 'image' && !isIgPhoto(item)) return false;
      if (typeFilter === 'video' && !isIgFeedVideo(item)) return false;
      if (typeFilter === 'reel' && !isIgReel(item)) return false;
      if (typeFilter === 'dp' && !isIgDp(item)) return false;
      if (typeFilter === 'highlight' && !isIgHighlight(item)) return false;
      if (typeFilter === 'story' && !isIgStory(item)) return false;
    } else {
      if (typeFilter === 'image' && item.mediaType !== 'image') return false;
      if (typeFilter === 'video' && item.mediaType !== 'video') return false;
    }

    if (normalizedQuery) {
      const haystack =
        `${item.title} ${item.author} ${item.sourceContainer} ${item.filename}`.toLowerCase();
      if (!haystack.includes(normalizedQuery)) return false;
    }
    return true;
  });

  const totalRenderPages = Math.max(
    1,
    Math.ceil(filteredItems.length / PAGE_RENDER_SIZE),
  );
  const safeRenderPage = Math.min(renderPage, totalRenderPages);
  const startIdx = (safeRenderPage - 1) * PAGE_RENDER_SIZE;
  const pageItems = filteredItems.slice(startIdx, startIdx + PAGE_RENDER_SIZE);

  useEffect(() => {
    setRenderPage(1);
  }, [platform, typeFilter, searchQuery]);

  const imageCount =
    platform === 'instagram'
      ? items.filter(isIgPhoto).length
      : items.filter((i) => i.mediaType === 'image').length;
  const videoCount =
    platform === 'instagram'
      ? items.filter(isIgFeedVideo).length
      : items.filter((i) => i.mediaType === 'video').length;
  const reelCount = platform === 'instagram' ? items.filter(isIgReel).length : 0;
  const dpCount = platform === 'instagram' ? items.filter(isIgDp).length : 0;
  const highlightCount =
    platform === 'instagram' ? items.filter(isIgHighlight).length : 0;
  const storyCount =
    platform === 'instagram' ? items.filter(isIgStory).length : 0;
  const showTypeTabs = imageCount > 0 && videoCount > 0;

  const allInstagramCategories: Array<{
    key: MediaTypeFilter;
    label: string;
    singular: string;
    count: number;
  }> = [
    { key: 'image', label: 'Photos', singular: 'Photo', count: imageCount },
    { key: 'video', label: 'Videos', singular: 'Video', count: videoCount },
    { key: 'reel', label: 'Reels', singular: 'Reel', count: reelCount },
    { key: 'dp', label: 'DP', singular: 'HD DP', count: dpCount },
    { key: 'highlight', label: 'Highlights', singular: 'Highlight', count: highlightCount },
    { key: 'story', label: 'Stories', singular: 'Story', count: storyCount },
  ];
  const nonEmptyInstagramCategories = allInstagramCategories.filter(
    (cat) => cat.count > 0,
  );

  const instagramTabs: Array<{
    key: MediaTypeFilter;
    label: string;
    count: number;
  }> =
    nonEmptyInstagramCategories.length >= 2
      ? [
          { key: 'all', label: 'All', count: items.length },
          ...nonEmptyInstagramCategories.map(({ key, label, count }) => ({
            key,
            label,
            count,
          })),
        ]
      : [];

  const privateProfileJobs = jobs.filter(
    (j) =>
      j.platform === 'instagram' &&
      j.status === 'ready' &&
      Boolean(j.isPrivateProfile),
  );

  const issueJobs = jobs.filter(
    (j) => j.status === 'auth_required' || j.status === 'error',
  );
  const paginatableJobs = jobs.filter(
    (j) => j.status === 'ready' && j.hasMore && Boolean(j.nextCursor),
  );

  const filteredIds = filteredItems.map((i) => i.id);
  const allFilteredSelected =
    filteredIds.length > 0 && filteredIds.every((id) => selectedIds.has(id));

  // Minimal empty state — no noisy titles or unused toolbars
  if (!isExtracting && items.length === 0 && issueJobs.length === 0) {
    return null;
  }

  return (
    <section
      aria-label={`${platform} staged media`}
      className="bg-white dark:bg-[#111114] border border-[#E4E4E7] dark:border-[#27272A] rounded-xl flex flex-col"
    >
      {/* Page-Level Download & Filter Bar (lives on each platform page, not in TopBar) */}
      {items.length > 0 && (
        <div className="px-3.5 py-3 sm:px-5 sm:py-3.5 border-b border-[#E4E4E7] dark:border-[#27272A] flex flex-col gap-2.5 sm:gap-3">
          {/* Primary Download Row */}
          <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center justify-between gap-2.5 sm:gap-3">
            <div className="flex flex-wrap items-center gap-2 sm:gap-2.5">
              <button
                type="button"
                onClick={onDownloadZip}
                disabled={selectedCount === 0 || isBundlingZip}
                className={`w-full sm:w-auto h-11 sm:h-10 px-4 inline-flex items-center justify-center gap-2 text-sm font-medium rounded-lg transition-all active:scale-[0.99] whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1D4ED8] dark:focus-visible:outline-[#3B82F6] ${
                  selectedCount > 0 && !isBundlingZip
                    ? 'bg-[#1D4ED8] dark:bg-[#2563EB] text-white hover:bg-[#1E40AF] dark:hover:bg-[#3B82F6]'
                    : 'bg-[#F4F4F5] dark:bg-[#18181B] text-[#A1A1AA] dark:text-[#52525B] cursor-not-allowed'
                }`}
              >
                {isBundlingZip ? (
                  <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Archive className="w-4 h-4" aria-hidden="true" />
                )}
                <span className="tabular-nums">
                  {isBundlingZip
                    ? zipProgressLabel || 'Packaging ZIP...'
                    : selectedCount > 0
                      ? zipPartCount > 1
                        ? `Download ${zipPartCount} ZIPs (${selectedCount})`
                        : `Download ZIP (${selectedCount})`
                      : 'Download ZIP'}
                </span>
              </button>

              <button
                type="button"
                onClick={onExportUrls}
                disabled={selectedCount === 0}
                title="Export selected direct media links for curl / aria2c"
                className="h-10 px-3 sm:px-3.5 inline-flex items-center gap-1.5 text-xs font-medium text-[#52525B] dark:text-[#D4D4D8] bg-[#FAFAFA] dark:bg-[#18181B] border border-[#E4E4E7] dark:border-[#27272A] hover:border-[#1D4ED8] dark:hover:border-[#3B82F6] hover:text-[#1D4ED8] dark:hover:text-[#60A5FA] rounded-lg transition-colors whitespace-nowrap shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <FileText className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Export .txt</span>
              </button>

              {paginatableJobs.length > 0 && (() => {
                const activeJob = paginatableJobs[0];
                const isLoadingMore = loadingMoreJobUrl === activeJob.sourceUrl;
                const isAutoLoading = autoLoadingJobUrl === activeJob.sourceUrl;
                const busy =
                  isExtracting ||
                  Boolean(loadingMoreJobUrl) ||
                  Boolean(autoLoadingJobUrl);

                return isAutoLoading ? (
                  <div className="inline-flex items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 text-xs font-mono tabular-nums text-[#52525B] dark:text-[#A1A1AA] px-1">
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-[#1D4ED8] dark:text-[#60A5FA]" aria-hidden="true" />
                      <span>
                        {activeJob.totalAvailable
                          ? `Loading ${activeJob.itemCount}/${activeJob.totalAvailable}`
                          : `Loading ${activeJob.itemCount}...`}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={onStopLoadAll}
                      className="h-10 px-3.5 inline-flex items-center gap-1.5 text-xs font-medium rounded-lg border border-[#B91C1C]/40 dark:border-[#F87171]/40 bg-[#FEF2F2] dark:bg-[#450A0A]/40 text-[#B91C1C] dark:text-[#F87171] hover:bg-[#FEE2E2] dark:hover:bg-[#450A0A]/70 transition-colors whitespace-nowrap shrink-0"
                    >
                      <Square className="w-3 h-3 fill-current" aria-hidden="true" />
                      <span>Stop</span>
                    </button>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => onLoadMore(activeJob)}
                      disabled={busy}
                      className="h-10 px-3 sm:px-3.5 inline-flex items-center gap-1.5 text-xs font-medium rounded-lg border border-[#E4E4E7] dark:border-[#27272A] bg-[#FAFAFA] dark:bg-[#18181B] text-[#09090B] dark:text-[#FAFAFA] hover:border-[#1D4ED8] dark:hover:border-[#3B82F6] hover:text-[#1D4ED8] dark:hover:text-[#60A5FA] transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
                    >
                      {isLoadingMore ? (
                        <>
                          <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                          <span>Loading...</span>
                        </>
                      ) : (
                        <>
                          <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>Load more</span>
                        </>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => onLoadAll(activeJob)}
                      disabled={busy}
                      className="h-10 px-3 sm:px-3.5 inline-flex items-center gap-1.5 text-xs font-medium rounded-lg border border-[#E4E4E7] dark:border-[#27272A] bg-white dark:bg-[#111114] text-[#52525B] dark:text-[#D4D4D8] hover:border-[#1D4ED8] dark:hover:border-[#3B82F6] hover:text-[#1D4ED8] dark:hover:text-[#60A5FA] transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
                    >
                      <span>
                        {activeJob.totalAvailable
                          ? `Load all (${activeJob.totalAvailable})`
                          : 'Load all'}
                      </span>
                    </button>
                  </>
                );
              })()}

              <span className="hidden sm:inline text-xs font-mono tabular-nums text-[#71717A] dark:text-[#A1A1AA] pl-1">
                {selectedCount}/{items.length} selected
                {zipPartCount > 1 ? ` · ${zipPartCount} parts` : ''}
              </span>
            </div>

            <div className="flex items-center justify-between sm:justify-end gap-3.5 text-xs">
              <span className="sm:hidden text-xs font-mono tabular-nums text-[#71717A] dark:text-[#A1A1AA]">
                {selectedCount}/{items.length} selected
                {zipPartCount > 1 ? ` · ${zipPartCount} parts` : ''}
              </span>
              <div className="flex items-center gap-3.5">
                {filteredIds.length > 0 && (
                  <button
                    type="button"
                    onClick={() =>
                      allFilteredSelected
                        ? onDeselectPlatform()
                        : onSelectVisible(filteredIds)
                    }
                    className="min-h-[36px] sm:min-h-0 inline-flex items-center font-medium text-[#1D4ED8] dark:text-[#60A5FA] hover:text-[#1E40AF] dark:hover:text-[#93C5FD] transition-colors whitespace-nowrap"
                  >
                    {allFilteredSelected ? 'Deselect all' : `Select all (${filteredIds.length})`}
                  </button>
                )}
                <button
                  type="button"
                  onClick={onClearPlatform}
                  className="min-h-[36px] sm:min-h-0 inline-flex items-center gap-1 font-medium text-[#71717A] dark:text-[#A1A1AA] hover:text-[#B91C1C] dark:hover:text-[#F87171] transition-colors whitespace-nowrap"
                >
                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Clear</span>
                </button>
              </div>
            </div>
          </div>

          {/* Secondary Filter / Duplicate Toggle / Search / View Row */}
          <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center justify-between gap-2.5">
            <div className="flex flex-wrap items-center gap-2.5 sm:gap-3 min-w-0 max-w-full">
              {platform === 'instagram' ? (
                instagramTabs.length > 0 ? (
                  <div
                    role="tablist"
                    aria-label="Filter Instagram media by category"
                    className="flex sm:inline-flex items-center p-1 sm:p-0.5 bg-[#F4F4F5] dark:bg-[#18181B] rounded-lg overflow-x-auto no-scrollbar w-full sm:w-auto max-w-full"
                  >
                    {instagramTabs.map((tab) => {
                      const isActive = typeFilter === tab.key;
                      return (
                        <button
                          key={tab.key}
                          type="button"
                          role="tab"
                          aria-selected={isActive}
                          onClick={() => onTypeFilterChange(tab.key)}
                          className={`min-h-[34px] sm:min-h-0 px-3 sm:px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 inline-flex items-center gap-1.5 ${
                            isActive
                              ? 'bg-white dark:bg-[#27272A] text-[#09090B] dark:text-[#FAFAFA] shadow-xs'
                              : 'text-[#52525B] dark:text-[#A1A1AA] hover:text-[#09090B] dark:hover:text-[#FAFAFA]'
                          }`}
                        >
                          <span>{tab.label}</span>
                          <span className="font-mono tabular-nums text-[11px] opacity-80">
                            {tab.count}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <span className="text-xs font-mono tabular-nums text-[#71717A] dark:text-[#A1A1AA]">
                    {nonEmptyInstagramCategories.length === 1
                      ? `${nonEmptyInstagramCategories[0].count} ${
                          nonEmptyInstagramCategories[0].count === 1
                            ? nonEmptyInstagramCategories[0].singular
                            : nonEmptyInstagramCategories[0].label
                        }`
                      : `${items.length} ${items.length === 1 ? 'file' : 'files'}`}
                  </span>
                )
              ) : showTypeTabs ? (
                <div
                  role="tablist"
                  aria-label="Filter by media type"
                  className="inline-flex items-center p-0.5 bg-[#F4F4F5] dark:bg-[#18181B] rounded-lg"
                >
                  {(
                    [
                      ['all', `All ${items.length}`],
                      ['image', `Photos ${imageCount}`],
                      ['video', `Videos ${videoCount}`],
                    ] as Array<[MediaTypeFilter, string]>
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      role="tab"
                      aria-selected={typeFilter === key}
                      onClick={() => onTypeFilterChange(key)}
                      className={`px-2.5 py-1 text-xs font-medium font-mono tabular-nums rounded-md transition-colors whitespace-nowrap ${
                        typeFilter === key
                          ? 'bg-white dark:bg-[#27272A] text-[#09090B] dark:text-[#FAFAFA] shadow-xs'
                          : 'text-[#52525B] dark:text-[#A1A1AA] hover:text-[#09090B] dark:hover:text-[#FAFAFA]'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              ) : (
                <span className="text-xs font-mono tabular-nums text-[#71717A] dark:text-[#A1A1AA]">
                  {videoCount > 0 ? `${videoCount} videos` : `${imageCount} photos`}
                </span>
              )}

              {(platform === 'reddit' || platform === 'redgifs') &&
                duplicateCount > 0 &&
                onToggleShowDuplicates && (
                  <button
                    type="button"
                    onClick={onToggleShowDuplicates}
                    aria-pressed={showDuplicates}
                    className={`px-2.5 py-1 text-xs font-mono tabular-nums rounded-md border transition-colors whitespace-nowrap shrink-0 ${
                      showDuplicates
                        ? 'bg-[#EFF6FF] dark:bg-[#1E3A8A]/30 border-[#1D4ED8]/40 dark:border-[#3B82F6]/40 text-[#1D4ED8] dark:text-[#60A5FA]'
                        : 'bg-[#FAFAFA] dark:bg-[#18181B] border-[#E4E4E7] dark:border-[#27272A] text-[#52525B] dark:text-[#D4D4D8] hover:border-[#1D4ED8] dark:hover:border-[#3B82F6] hover:text-[#1D4ED8] dark:hover:text-[#60A5FA]'
                    }`}
                  >
                    {showDuplicates
                      ? `Showing ${duplicateCount} ${duplicateCount === 1 ? 'duplicate' : 'duplicates'} · Hide`
                      : `${duplicateCount} ${duplicateCount === 1 ? 'duplicate' : 'duplicates'} hidden · Show`}
                  </button>
                )}

              {(platform === 'reddit' || platform === 'redgifs') && visualScanProgress && (
                <span className="inline-flex items-center gap-1.5 text-xs font-mono tabular-nums text-[#71717A] dark:text-[#A1A1AA] whitespace-nowrap">
                  <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                  <span>
                    Scanning visuals {visualScanProgress.scanned}/{visualScanProgress.total}
                  </span>
                </span>
              )}
            </div>

            <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
              <div className="relative flex-1 sm:w-48">
                <Search
                  className="w-3.5 h-3.5 text-[#A1A1AA] dark:text-[#71717A] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                  aria-hidden="true"
                />
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(e) => onSearchQueryChange(e.target.value)}
                  placeholder="Filter..."
                  aria-label="Filter staged files"
                  className="w-full h-10 sm:h-8 pl-8 pr-3 text-base sm:text-xs bg-[#FAFAFA] dark:bg-[#18181B] border border-[#E4E4E7] dark:border-[#27272A] rounded-lg text-[#09090B] dark:text-[#FAFAFA] placeholder:text-xs placeholder:text-[#A1A1AA] dark:placeholder:text-[#71717A] focus:bg-white dark:focus:bg-[#111114] focus:outline-none focus:border-[#1D4ED8] dark:focus:border-[#3B82F6] transition-colors"
                />
              </div>

              <div
                role="group"
                aria-label="View layout"
                className="inline-flex items-center p-0.5 bg-[#F4F4F5] dark:bg-[#18181B] rounded-lg shrink-0"
              >
                <button
                  type="button"
                  onClick={() => onViewModeChange('grid')}
                  aria-label="Grid view"
                  aria-pressed={viewMode === 'grid'}
                  className={`min-w-[36px] min-h-[36px] sm:min-w-0 sm:min-h-0 inline-flex items-center justify-center p-1.5 rounded-md transition-colors ${
                    viewMode === 'grid'
                      ? 'bg-white dark:bg-[#27272A] text-[#09090B] dark:text-[#FAFAFA] shadow-xs'
                      : 'text-[#52525B] dark:text-[#A1A1AA] hover:text-[#09090B] dark:hover:text-[#FAFAFA]'
                  }`}
                >
                  <LayoutGrid className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => onViewModeChange('table')}
                  aria-label="Table view"
                  aria-pressed={viewMode === 'table'}
                  className={`min-w-[36px] min-h-[36px] sm:min-w-0 sm:min-h-0 inline-flex items-center justify-center p-1.5 rounded-md transition-colors ${
                    viewMode === 'table'
                      ? 'bg-white dark:bg-[#27272A] text-[#09090B] dark:text-[#FAFAFA] shadow-xs'
                      : 'text-[#52525B] dark:text-[#A1A1AA] hover:text-[#09090B] dark:hover:text-[#FAFAFA]'
                  }`}
                >
                  <List className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
                </button>
              </div>
            </div>
          </div>

          {/* Interactive Multi-Part ZIP Queue (prevents browser/iframe multi-download blocks from losing parts) */}
          {zipParts.length > 1 && (
            <div className="pt-3 border-t border-[#F4F4F5] dark:border-[#27272A] flex flex-col gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="text-[#52525B] dark:text-[#A1A1AA]">
                  ZIP parts ready — click any part below if your browser blocked automatic multi-file downloads.
                </span>
                <div className="flex items-center gap-3 shrink-0">
                  {isBundlingZip && onStopZip && (
                    <button
                      type="button"
                      onClick={onStopZip}
                      className="inline-flex items-center gap-1 font-medium text-[#B91C1C] dark:text-[#F87171] hover:underline whitespace-nowrap"
                    >
                      <Square className="w-3 h-3 fill-current" aria-hidden="true" />
                      <span>Stop</span>
                    </button>
                  )}
                  {!isBundlingZip && onDismissZipParts && (
                    <button
                      type="button"
                      onClick={onDismissZipParts}
                      aria-label="Dismiss ZIP parts bar"
                      className="inline-flex items-center gap-1 text-[#71717A] dark:text-[#A1A1AA] hover:text-[#09090B] dark:hover:text-[#FAFAFA] whitespace-nowrap"
                    >
                      <X className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>Close</span>
                    </button>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {zipParts.map((part) => {
                  const sizeText = formatByteSize(part.sizeBytes);
                  if (part.status === 'downloaded' && part.blobUrl) {
                    return (
                      <button
                        key={part.partNumber}
                        type="button"
                        onClick={() => onSaveZipPart?.(part.partNumber)}
                        title={`Save ${part.filename}`}
                        className="h-8 px-2.5 inline-flex items-center gap-1.5 text-xs font-mono tabular-nums rounded-md border border-[#E4E4E7] dark:border-[#27272A] bg-[#FAFAFA] dark:bg-[#18181B] text-[#09090B] dark:text-[#FAFAFA] hover:border-[#1D4ED8] dark:hover:border-[#3B82F6] hover:text-[#1D4ED8] dark:hover:text-[#60A5FA] transition-colors whitespace-nowrap shrink-0"
                      >
                        <Download className="w-3 h-3 text-[#15803D] dark:text-[#4ADE80]" aria-hidden="true" />
                        <span>
                          Part {part.partNumber} ({part.fileCount}
                          {sizeText ? ` · ${sizeText}` : ''})
                        </span>
                      </button>
                    );
                  }
                  if (part.status === 'building') {
                    return (
                      <span
                        key={part.partNumber}
                        className="h-8 px-2.5 inline-flex items-center gap-1.5 text-xs font-mono tabular-nums rounded-md border border-[#1D4ED8]/40 dark:border-[#3B82F6]/40 bg-[#EFF6FF] dark:bg-[#1E3A8A]/25 text-[#1D4ED8] dark:text-[#60A5FA] whitespace-nowrap shrink-0"
                      >
                        <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                        <span>Part {part.partNumber} packaging...</span>
                      </span>
                    );
                  }
                  if (part.status === 'error') {
                    return (
                      <button
                        key={part.partNumber}
                        type="button"
                        onClick={() => onRetryZipPart?.(part.partNumber)}
                        disabled={isBundlingZip}
                        title={part.error || 'Packaging failed — click to retry'}
                        className="h-8 px-2.5 inline-flex items-center gap-1.5 text-xs font-mono tabular-nums rounded-md border border-[#B91C1C]/40 dark:border-[#F87171]/40 bg-[#FEF2F2] dark:bg-[#450A0A]/40 text-[#B91C1C] dark:text-[#F87171] hover:bg-[#FEE2E2] dark:hover:bg-[#450A0A]/70 transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
                      >
                        <RotateCw className="w-3 h-3" aria-hidden="true" />
                        <span>Part {part.partNumber} · Retry</span>
                      </button>
                    );
                  }
                  return (
                    <span
                      key={part.partNumber}
                      className="h-8 px-2.5 inline-flex items-center text-xs font-mono tabular-nums text-[#71717A] dark:text-[#71717A] border border-dashed border-[#E4E4E7] dark:border-[#27272A] rounded-md whitespace-nowrap shrink-0"
                    >
                      Part {part.partNumber} ({part.fileCount}) · Queued
                    </span>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Main Content */}
      <div className="p-3 sm:p-5 flex flex-col gap-4 sm:gap-5">
        {/* Private Profile HD DP Notice */}
        {platform === 'instagram' && privateProfileJobs.length > 0 && (
          <div className="rounded-lg border border-[#E4E4E7] dark:border-[#27272A] bg-[#FAFAFA] dark:bg-[#18181B]/70 px-3.5 py-2.5 flex items-start gap-2.5 text-xs">
            <Lock
              className="w-3.5 h-3.5 text-[#52525B] dark:text-[#A1A1AA] shrink-0 mt-0.5"
              aria-hidden="true"
            />
            <div className="space-y-1 text-[#52525B] dark:text-[#A1A1AA] leading-relaxed">
              {privateProfileJobs.map((job) => (
                <p key={job.id}>{job.message}</p>
              ))}
            </div>
          </div>
        )}

        {/* Highlight Covers Zero-Login Note */}
        {platform === 'instagram' &&
          !hasInstagramSession &&
          typeFilter === 'highlight' &&
          filteredItems.length > 0 && (
            <p className="text-xs text-[#71717A] dark:text-[#A1A1AA]">
              Highlight cover images download without login. Connect Session unlock above to download all individual slides inside Highlights.
            </p>
          )}

        {/* Loading Skeleton */}
        {isExtracting && items.length === 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-4">
            {Array.from({ length: 8 }).map((_, idx) => (
              <div
                key={idx}
                className="border border-[#E4E4E7] dark:border-[#27272A] rounded-lg overflow-hidden"
              >
                <div className="aspect-square sm:aspect-[4/3] bg-[#F4F4F5] dark:bg-[#18181B] animate-pulse" />
                <div className="p-2.5 sm:p-3 space-y-2">
                  <div className="h-3.5 w-3/4 bg-[#F4F4F5] dark:bg-[#18181B] rounded-xs animate-pulse" />
                  <div className="h-3 w-1/2 bg-[#F4F4F5] dark:bg-[#18181B] rounded-xs animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* No Filter Matches */}
        {!isExtracting && items.length > 0 && filteredItems.length === 0 && (
          <div className="py-10 px-4 text-center max-w-md mx-auto">
            {platform === 'instagram' && !normalizedQuery && typeFilter === 'story' ? (
              <>
                <p className="text-sm font-medium text-[#09090B] dark:text-[#FAFAFA]">
                  {hasInstagramSession
                    ? 'No active 24-hour Stories right now'
                    : 'Active Stories require an Instagram session'}
                </p>
                <p className="mt-1.5 text-xs text-[#52525B] dark:text-[#A1A1AA] leading-relaxed">
                  {hasInstagramSession
                    ? 'This profile has no active Stories published in the last 24 hours.'
                    : 'Instagram hides active 24-hour Stories when logged out. Open Session unlock above to connect a temporary sessionid, or keep using zero-login mode.'}
                </p>
                <button
                  type="button"
                  onClick={() => onTypeFilterChange('all')}
                  className="mt-3 text-xs font-medium text-[#1D4ED8] dark:text-[#60A5FA] hover:underline underline-offset-2"
                >
                  View all loaded files
                </button>
              </>
            ) : platform === 'instagram' &&
              !normalizedQuery &&
              privateProfileJobs.length > 0 &&
              typeFilter !== 'dp' &&
              dpCount > 0 ? (
              <>
                <p className="text-sm font-medium text-[#09090B] dark:text-[#FAFAFA]">
                  Private profile content is hidden by Instagram
                </p>
                <p className="mt-1.5 text-xs text-[#52525B] dark:text-[#A1A1AA] leading-relaxed">
                  Posts, reels, highlights, and stories are locked on private accounts, but the full HD profile picture (DP) is ready.
                </p>
                <button
                  type="button"
                  onClick={() => onTypeFilterChange('dp')}
                  className="mt-3 text-xs font-medium text-[#1D4ED8] dark:text-[#60A5FA] hover:underline underline-offset-2"
                >
                  View HD DP ({dpCount})
                </button>
              </>
            ) : platform === 'instagram' &&
              !normalizedQuery &&
              typeFilter === 'highlight' ? (
              <>
                <p className="text-sm text-[#52525B] dark:text-[#A1A1AA]">
                  No public Highlights found on this profile.
                </p>
                <button
                  type="button"
                  onClick={() => onTypeFilterChange('all')}
                  className="mt-2 text-xs font-medium text-[#1D4ED8] dark:text-[#60A5FA] hover:underline underline-offset-2"
                >
                  View all loaded files
                </button>
              </>
            ) : (
              <>
                <p className="text-sm text-[#52525B] dark:text-[#A1A1AA]">
                  No matching files.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    onTypeFilterChange('all');
                    onSearchQueryChange('');
                  }}
                  className="mt-2 text-xs font-medium text-[#1D4ED8] dark:text-[#60A5FA] hover:underline underline-offset-2"
                >
                  Reset filter
                </button>
              </>
            )}
          </div>
        )}

        {/* Optimized Windowed Grid View (60 per view page for smooth 600+ performance) */}
        {pageItems.length > 0 && viewMode === 'grid' && (
          <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2.5 sm:gap-4">
            {pageItems.map((item) => {
              const isSelected = selectedIds.has(item.id);
              const dupInfo = duplicateAnnotations?.get(item.id);
              const isDup = Boolean(dupInfo?.isDuplicate);
              const repeatCount = dupInfo?.repeatCount ?? 0;
              const dateLabel = formatShortDate(item.createdAt);

              return (
                <article
                  key={item.id}
                  className={`group border rounded-lg overflow-hidden flex flex-col transition-[border-color,opacity] duration-150 ${
                    isDup ? 'opacity-75 hover:opacity-100' : ''
                  } ${
                    isSelected
                      ? 'border-[#1D4ED8] dark:border-[#3B82F6] bg-white dark:bg-[#141418]'
                      : 'border-[#E4E4E7] dark:border-[#27272A] bg-white dark:bg-[#141418] hover:border-[#D4D4D8] dark:hover:border-[#3F3F46]'
                  }`}
                >
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => onPreviewItem(item)}
                      aria-label={`Preview ${item.title}`}
                      className="block w-full text-left focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-[#1D4ED8] dark:focus-visible:outline-[#3B82F6]"
                    >
                      <MediaThumbnail item={item} aspectClass="aspect-square sm:aspect-[4/3]" />
                    </button>

                    <button
                      type="button"
                      onClick={() => onToggleSelect(item.id)}
                      aria-label={
                        isSelected
                          ? `Deselect ${item.filename}`
                          : `Select ${item.filename}`
                      }
                      aria-pressed={isSelected}
                      className="absolute top-0 left-0 w-11 h-11 sm:w-10 sm:h-10 flex items-start justify-start p-2 sm:p-2.5"
                    >
                      <span
                        className={`w-6 h-6 rounded-md border flex items-center justify-center transition-colors shadow-xs ${
                          isSelected
                            ? 'bg-[#1D4ED8] dark:bg-[#2563EB] border-[#1D4ED8] dark:border-[#2563EB] text-white'
                            : 'bg-white/95 dark:bg-[#18181B]/90 border-[#D4D4D8] dark:border-[#3F3F46] text-transparent hover:border-[#71717A]'
                        }`}
                      >
                        <Check className="w-3.5 h-3.5" strokeWidth={2.5} />
                      </span>
                    </button>
                  </div>

                  <div className="p-2.5 sm:p-3 flex-1 flex flex-col justify-between gap-2 sm:gap-2.5">
                    <div className="space-y-0.5">
                      <h4
                        title={item.title}
                        className="text-xs font-medium text-[#09090B] dark:text-[#FAFAFA] truncate"
                      >
                        {item.title}
                      </h4>
                      <div className="flex items-center gap-1 sm:gap-1.5 text-[11px] text-[#71717A] dark:text-[#A1A1AA] truncate">
                        <span className="shrink-0">{formatContentLabel(item)}</span>
                        <span aria-hidden="true" className="hidden sm:inline">·</span>
                        <span className="hidden sm:inline truncate">{item.sourceContainer}</span>
                        {dateLabel && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono tabular-nums truncate">
                              {dateLabel}
                            </span>
                          </>
                        )}
                      </div>
                      {isDup ? (
                        <p className="text-[11px] text-[#B45309] dark:text-[#FBBF24] truncate">
                          Duplicate · {formatDuplicateReason(dupInfo?.matchReason)}
                        </p>
                      ) : repeatCount > 0 ? (
                        <p className="text-[11px] font-mono tabular-nums text-[#52525B] dark:text-[#A1A1AA] truncate">
                          Original · {repeatCount}{' '}
                          {repeatCount === 1 ? 'repeat' : 'repeats'}
                        </p>
                      ) : null}
                    </div>

                    <div className="pt-1.5 sm:pt-2 border-t border-[#F4F4F5] dark:border-[#27272A] flex items-center justify-between gap-1.5 sm:gap-2">
                      <button
                        type="button"
                        onClick={() => onPreviewItem(item)}
                        className="min-h-[32px] sm:min-h-0 inline-flex items-center gap-1 text-xs font-medium text-[#52525B] dark:text-[#A1A1AA] hover:text-[#09090B] dark:hover:text-[#FAFAFA] transition-colors whitespace-nowrap"
                      >
                        <Eye className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>View</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => onDownloadSingle(item)}
                        className="min-h-[32px] sm:min-h-0 inline-flex items-center gap-1 text-xs font-medium text-[#1D4ED8] dark:text-[#60A5FA] hover:text-[#1E40AF] dark:hover:text-[#93C5FD] transition-colors whitespace-nowrap"
                      >
                        <Download className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>{item.extension.toUpperCase()}</span>
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}

        {/* High-Density Table View */}
        {pageItems.length > 0 && viewMode === 'table' && (
          <div className="overflow-x-auto -mx-3 sm:-mx-5 px-3 sm:px-5">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[#E4E4E7] dark:border-[#27272A] text-xs font-medium text-[#71717A] dark:text-[#A1A1AA]">
                  <th className="py-2 pr-2 sm:pr-3 w-8">
                    <span className="sr-only">Select</span>
                  </th>
                  <th className="py-2 pr-3 sm:pr-4">File</th>
                  <th className="hidden md:table-cell py-2 pr-4">Source</th>
                  <th className="hidden sm:table-cell py-2 pr-4">Format</th>
                  <th className="hidden lg:table-cell py-2 pr-4 text-right">Size</th>
                  <th className="py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#F4F4F5] dark:divide-[#27272A] text-sm">
                {pageItems.map((item) => {
                  const isSelected = selectedIds.has(item.id);
                  const dupInfo = duplicateAnnotations?.get(item.id);
                  const isDup = Boolean(dupInfo?.isDuplicate);
                  const repeatCount = dupInfo?.repeatCount ?? 0;
                  const dateLabel = formatShortDate(item.createdAt);

                  return (
                    <tr
                      key={item.id}
                      className={`transition-colors ${
                        isDup ? 'opacity-75 hover:opacity-100' : ''
                      } ${
                        isSelected
                          ? 'bg-[#EFF6FF]/60 dark:bg-[#1E3A8A]/20'
                          : 'hover:bg-[#FAFAFA] dark:hover:bg-[#18181B]/70'
                      }`}
                    >
                      <td className="py-2.5 sm:py-2 pr-2 sm:pr-3">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => onToggleSelect(item.id)}
                          aria-label={`Select ${item.filename}`}
                          className="w-4 h-4 rounded-xs border-[#D4D4D8] dark:border-[#3F3F46] accent-[#1D4ED8] dark:accent-[#3B82F6]"
                        />
                      </td>
                      <td className="py-2.5 sm:py-2 pr-3 sm:pr-4 max-w-[180px] sm:max-w-[300px]">
                        <div className="flex items-center gap-2.5 sm:gap-3">
                          <button
                            type="button"
                            onClick={() => onPreviewItem(item)}
                            aria-label={`Preview ${item.title}`}
                            className="w-10 h-10 sm:w-9 sm:h-9 rounded-xs overflow-hidden bg-[#F4F4F5] dark:bg-[#18181B] shrink-0 border border-[#E4E4E7] dark:border-[#27272A]"
                          >
                            <MediaThumbnail item={item} aspectClass="aspect-square" />
                          </button>
                          <div className="min-w-0">
                            <p className="text-xs font-medium text-[#09090B] dark:text-[#FAFAFA] truncate">
                              {item.title}
                            </p>
                            <p className="text-[11px] font-mono text-[#71717A] dark:text-[#A1A1AA] truncate">
                              {item.filename}
                              {isDup
                                ? ` · Duplicate (${formatDuplicateReason(dupInfo?.matchReason)})`
                                : repeatCount > 0
                                  ? ` · Original (${repeatCount} ${repeatCount === 1 ? 'repeat' : 'repeats'})`
                                  : ''}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="hidden md:table-cell py-2 pr-4 text-xs text-[#52525B] dark:text-[#D4D4D8] whitespace-nowrap">
                        <span>{item.sourceContainer}</span>
                        {dateLabel && (
                          <span className="ml-1.5 font-mono tabular-nums text-[#71717A] dark:text-[#A1A1AA]">
                            · {dateLabel}
                          </span>
                        )}
                      </td>
                      <td className="hidden sm:table-cell py-2 pr-4 text-xs font-mono text-[#52525B] dark:text-[#A1A1AA] whitespace-nowrap">
                        {formatContentLabel(item)} · {item.extension.toUpperCase()}
                      </td>
                      <td className="hidden lg:table-cell py-2 pr-4 text-xs font-mono tabular-nums text-[#71717A] dark:text-[#A1A1AA] text-right whitespace-nowrap">
                        {item.width && item.height
                          ? `${item.width}×${item.height}`
                          : '—'}
                      </td>
                      <td className="py-2 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-3 text-xs font-medium">
                          <button
                            type="button"
                            onClick={() => onPreviewItem(item)}
                            className="text-[#52525B] dark:text-[#A1A1AA] hover:text-[#09090B] dark:hover:text-[#FAFAFA]"
                          >
                            Preview
                          </button>
                          <button
                            type="button"
                            onClick={() => onDownloadSingle(item)}
                            className="text-[#1D4ED8] dark:text-[#60A5FA] hover:text-[#1E40AF] dark:hover:text-[#93C5FD]"
                          >
                            Download
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Client-Side View Pagination (keeps DOM fast when 600+ items are loaded) */}
        {totalRenderPages > 1 && (
          <div className="pt-3 border-t border-[#F4F4F5] dark:border-[#27272A] flex items-center justify-between gap-3 text-xs">
            <span className="font-mono tabular-nums text-[#71717A] dark:text-[#A1A1AA]">
              Showing {startIdx + 1}–
              {Math.min(startIdx + PAGE_RENDER_SIZE, filteredItems.length)} of{' '}
              {filteredItems.length}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setRenderPage((p) => Math.max(1, p - 1))}
                disabled={safeRenderPage <= 1}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-[#E4E4E7] dark:border-[#27272A] text-[#52525B] dark:text-[#D4D4D8] hover:text-[#09090B] dark:hover:text-[#FAFAFA] disabled:opacity-40"
              >
                <ChevronLeft className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Prev</span>
              </button>
              <span className="font-mono tabular-nums text-[#52525B] dark:text-[#A1A1AA] px-1">
                {safeRenderPage} / {totalRenderPages}
              </span>
              <button
                type="button"
                onClick={() =>
                  setRenderPage((p) => Math.min(totalRenderPages, p + 1))
                }
                disabled={safeRenderPage >= totalRenderPages}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-[#E4E4E7] dark:border-[#27272A] text-[#52525B] dark:text-[#D4D4D8] hover:text-[#09090B] dark:hover:text-[#FAFAFA] disabled:opacity-40"
              >
                <span>Next</span>
                <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </div>
          </div>
        )}

        {/* Load More / Load All (with Stop) Pagination Bar */}
        {paginatableJobs.length > 0 && (
          <div className="pt-4 border-t border-[#E4E4E7] dark:border-[#27272A] flex flex-col gap-3">
            {paginatableJobs.map((job) => {
              const isLoadingThis = loadingMoreJobUrl === job.sourceUrl;
              const isAutoLoadingThis = autoLoadingJobUrl === job.sourceUrl;
              const shortSource = job.sourceUrl
                .replace(/^https?:\/\/(www\.)?/, '')
                .replace(/\/$/, '');
              const busy = isExtracting || Boolean(loadingMoreJobUrl) || Boolean(autoLoadingJobUrl);

              return (
                <div
                  key={job.id}
                  className="flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                >
                  <p className="text-xs text-[#52525B] dark:text-[#A1A1AA] truncate">
                    <span className="font-mono text-[#09090B] dark:text-[#FAFAFA]">
                      {shortSource}
                    </span>
                    <span className="mx-1.5" aria-hidden="true">
                      ·
                    </span>
                    <span className="font-mono tabular-nums">
                      {job.totalAvailable
                        ? `${job.itemCount} of ${job.totalAvailable} loaded`
                        : `${job.itemCount} loaded`}{' '}
                      (Page {job.pageNumber || 1})
                    </span>
                  </p>

                  <div className="flex items-center gap-2 shrink-0">
                    {isAutoLoadingThis ? (
                      <button
                        type="button"
                        onClick={onStopLoadAll}
                        className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-[#B91C1C]/40 dark:border-[#F87171]/40 bg-[#FEF2F2] dark:bg-[#450A0A]/40 text-[#B91C1C] dark:text-[#F87171] hover:bg-[#FEE2E2] dark:hover:bg-[#450A0A]/70 transition-colors whitespace-nowrap"
                      >
                        <Square className="w-3 h-3 fill-current" aria-hidden="true" />
                        <span>Stop ({job.itemCount})</span>
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => onLoadMore(job)}
                          disabled={busy}
                          className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-[#E4E4E7] dark:border-[#27272A] bg-[#FAFAFA] dark:bg-[#18181B] text-[#09090B] dark:text-[#FAFAFA] hover:border-[#1D4ED8] dark:hover:border-[#3B82F6] hover:text-[#1D4ED8] dark:hover:text-[#60A5FA] transition-colors whitespace-nowrap disabled:opacity-50"
                        >
                          {isLoadingThis ? (
                            <>
                              <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                              <span>Loading...</span>
                            </>
                          ) : (
                            <>
                              <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
                              <span>Load more</span>
                            </>
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => onLoadAll(job)}
                          disabled={busy}
                          className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-[#E4E4E7] dark:border-[#27272A] bg-white dark:bg-[#111114] text-[#52525B] dark:text-[#D4D4D8] hover:border-[#1D4ED8] dark:hover:border-[#3B82F6] hover:text-[#1D4ED8] dark:hover:text-[#60A5FA] transition-colors whitespace-nowrap disabled:opacity-50"
                        >
                          <span>
                            {job.totalAvailable
                              ? `Load all (${job.totalAvailable})`
                              : 'Load all'}
                          </span>
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Auth-Required / Failed Notices */}
        {issueJobs.length > 0 && (
          <div className={items.length > 0 ? 'pt-4 border-t border-[#E4E4E7] dark:border-[#27272A]' : ''}>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-[#52525B] dark:text-[#A1A1AA]">
                Notices ({issueJobs.length})
              </span>
              {items.length === 0 && (
                <button
                  type="button"
                  onClick={onClearPlatform}
                  className="text-xs font-medium text-[#71717A] dark:text-[#A1A1AA] hover:text-[#09090B] dark:hover:text-[#FAFAFA]"
                >
                  Dismiss
                </button>
              )}
            </div>
            <ul className="divide-y divide-[#F4F4F5] dark:divide-[#27272A]">
              {issueJobs.map((job) => {
                const isAuth = job.status === 'auth_required';
                return (
                  <li
                    key={job.id}
                    className="py-2.5 flex flex-col sm:flex-row sm:items-start justify-between gap-3"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex items-center gap-2 text-xs">
                        <AlertTriangle
                          className={`w-3.5 h-3.5 shrink-0 ${
                            isAuth
                              ? 'text-[#B45309] dark:text-[#FBBF24]'
                              : 'text-[#B91C1C] dark:text-[#F87171]'
                          }`}
                          aria-hidden="true"
                        />
                        <span
                          className={`font-medium ${
                            isAuth
                              ? 'text-[#B45309] dark:text-[#FBBF24]'
                              : 'text-[#B91C1C] dark:text-[#F87171]'
                          }`}
                        >
                          {isAuth ? 'Access Restricted' : 'Unable to Fetch'}
                        </span>
                        <span aria-hidden="true" className="text-[#A1A1AA]">
                          ·
                        </span>
                        <span className="font-mono text-[#71717A] dark:text-[#A1A1AA] truncate">
                          {job.sourceUrl.replace(/^https?:\/\/(www\.)?/, '')}
                        </span>
                      </div>
                      <p className="text-xs text-[#52525B] dark:text-[#A1A1AA] leading-relaxed">
                        {job.message}
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={() => onRetryJob(job.sourceUrl)}
                      disabled={isExtracting}
                      className="inline-flex items-center gap-1 text-xs font-medium text-[#52525B] dark:text-[#A1A1AA] hover:text-[#09090B] dark:hover:text-[#FAFAFA] transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
                    >
                      <RotateCw className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>Retry</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
