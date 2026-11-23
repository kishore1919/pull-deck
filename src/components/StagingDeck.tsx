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
  RotateCw,
  Search,
  Square,
  Trash2,
} from 'lucide-react';
import type { ExtractionJob, MediaItem, Platform } from '../types';
import { MediaThumbnail } from './MediaThumbnail';

export type MediaTypeFilter = 'all' | 'image' | 'video';

const PAGE_RENDER_SIZE = 60;

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
  selectedCount: number;
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
}

function formatContentLabel(item: MediaItem): string {
  if (item.platform === 'instagram') {
    if (item.contentType === 'ig_story') return 'Story';
    if (item.contentType === 'ig_highlight') return 'Highlight';
    if (item.contentType === 'ig_reel') return 'Reel';
    return item.groupSize > 1
      ? `Slide ${item.indexInGroup}/${item.groupSize}`
      : 'Post';
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
  selectedCount,
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
}: StagingDeckProps) {
  const [renderPage, setRenderPage] = useState(1);

  const normalizedQuery = searchQuery.trim().toLowerCase();

  const filteredItems = items.filter((item) => {
    if (typeFilter === 'image' && item.mediaType !== 'image') return false;
    if (typeFilter === 'video' && item.mediaType !== 'video') return false;

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

  const imageCount = items.filter((i) => i.mediaType === 'image').length;
  const videoCount = items.filter((i) => i.mediaType === 'video').length;
  const showTypeTabs = imageCount > 0 && videoCount > 0;

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
        <div className="px-4 py-3.5 sm:px-5 border-b border-[#E4E4E7] dark:border-[#27272A] flex flex-col gap-3">
          {/* Primary Download Row */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={onDownloadZip}
                disabled={selectedCount === 0 || isBundlingZip}
                className={`h-10 px-4 inline-flex items-center gap-2 text-sm font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1D4ED8] dark:focus-visible:outline-[#3B82F6] ${
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
                className="h-10 px-3.5 inline-flex items-center gap-1.5 text-xs font-medium text-[#52525B] dark:text-[#D4D4D8] bg-[#FAFAFA] dark:bg-[#18181B] border border-[#E4E4E7] dark:border-[#27272A] hover:border-[#1D4ED8] dark:hover:border-[#3B82F6] hover:text-[#1D4ED8] dark:hover:text-[#60A5FA] rounded-lg transition-colors whitespace-nowrap shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <FileText className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Export .txt</span>
              </button>

              <span className="text-xs font-mono tabular-nums text-[#71717A] dark:text-[#A1A1AA] pl-1">
                {selectedCount}/{items.length} selected
                {zipPartCount > 1 ? ` · ${zipPartCount} parts` : ''}
              </span>
            </div>

            <div className="flex items-center gap-3.5 text-xs">
              {filteredIds.length > 0 && (
                <button
                  type="button"
                  onClick={() =>
                    allFilteredSelected
                      ? onDeselectPlatform()
                      : onSelectVisible(filteredIds)
                  }
                  className="font-medium text-[#1D4ED8] dark:text-[#60A5FA] hover:text-[#1E40AF] dark:hover:text-[#93C5FD] transition-colors whitespace-nowrap"
                >
                  {allFilteredSelected ? 'Deselect all' : `Select all (${filteredIds.length})`}
                </button>
              )}
              <button
                type="button"
                onClick={onClearPlatform}
                className="inline-flex items-center gap-1 font-medium text-[#71717A] dark:text-[#A1A1AA] hover:text-[#B91C1C] dark:hover:text-[#F87171] transition-colors whitespace-nowrap"
              >
                <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Clear</span>
              </button>
            </div>
          </div>

          {/* Secondary Filter / Search / View Row */}
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            {showTypeTabs ? (
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

            <div className="flex items-center gap-2 flex-1 sm:flex-initial justify-end">
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
                  className="w-full h-8 pl-8 pr-3 text-xs bg-[#FAFAFA] dark:bg-[#18181B] border border-[#E4E4E7] dark:border-[#27272A] rounded-lg text-[#09090B] dark:text-[#FAFAFA] placeholder:text-[#A1A1AA] dark:placeholder:text-[#71717A] focus:bg-white dark:focus:bg-[#111114] focus:outline-none focus:border-[#1D4ED8] dark:focus:border-[#3B82F6] transition-colors"
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
                  className={`p-1.5 rounded-md transition-colors ${
                    viewMode === 'grid'
                      ? 'bg-white dark:bg-[#27272A] text-[#09090B] dark:text-[#FAFAFA] shadow-xs'
                      : 'text-[#52525B] dark:text-[#A1A1AA] hover:text-[#09090B] dark:hover:text-[#FAFAFA]'
                  }`}
                >
                  <LayoutGrid className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => onViewModeChange('table')}
                  aria-label="Table view"
                  aria-pressed={viewMode === 'table'}
                  className={`p-1.5 rounded-md transition-colors ${
                    viewMode === 'table'
                      ? 'bg-white dark:bg-[#27272A] text-[#09090B] dark:text-[#FAFAFA] shadow-xs'
                      : 'text-[#52525B] dark:text-[#A1A1AA] hover:text-[#09090B] dark:hover:text-[#FAFAFA]'
                  }`}
                >
                  <List className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Main Content */}
      <div className="p-4 sm:p-5 flex flex-col gap-5">
        {/* Loading Skeleton */}
        {isExtracting && items.length === 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {Array.from({ length: 8 }).map((_, idx) => (
              <div
                key={idx}
                className="border border-[#E4E4E7] dark:border-[#27272A] rounded-lg overflow-hidden"
              >
                <div className="aspect-[4/3] bg-[#F4F4F5] dark:bg-[#18181B] animate-pulse" />
                <div className="p-3 space-y-2">
                  <div className="h-3.5 w-3/4 bg-[#F4F4F5] dark:bg-[#18181B] rounded-xs animate-pulse" />
                  <div className="h-3 w-1/2 bg-[#F4F4F5] dark:bg-[#18181B] rounded-xs animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* No Filter Matches */}
        {!isExtracting && items.length > 0 && filteredItems.length === 0 && (
          <div className="py-10 text-center">
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
          </div>
        )}

        {/* Optimized Windowed Grid View (60 per view page for smooth 600+ performance) */}
        {pageItems.length > 0 && viewMode === 'grid' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {pageItems.map((item) => {
              const isSelected = selectedIds.has(item.id);
              return (
                <article
                  key={item.id}
                  className={`group border rounded-lg overflow-hidden flex flex-col transition-colors ${
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
                      <MediaThumbnail item={item} aspectClass="aspect-[4/3]" />
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
                      className={`absolute top-2.5 left-2.5 w-6 h-6 rounded-md border flex items-center justify-center transition-colors ${
                        isSelected
                          ? 'bg-[#1D4ED8] dark:bg-[#2563EB] border-[#1D4ED8] dark:border-[#2563EB] text-white'
                          : 'bg-white/95 dark:bg-[#18181B]/90 border-[#D4D4D8] dark:border-[#3F3F46] text-transparent hover:border-[#71717A]'
                      }`}
                    >
                      <Check className="w-3.5 h-3.5" strokeWidth={2.5} />
                    </button>
                  </div>

                  <div className="p-3 flex-1 flex flex-col justify-between gap-2.5">
                    <div className="space-y-0.5">
                      <h4
                        title={item.title}
                        className="text-xs font-medium text-[#09090B] dark:text-[#FAFAFA] truncate"
                      >
                        {item.title}
                      </h4>
                      <div className="flex items-center gap-1.5 text-[11px] text-[#71717A] dark:text-[#A1A1AA] truncate">
                        <span>{formatContentLabel(item)}</span>
                        <span aria-hidden="true">·</span>
                        <span className="truncate">{item.sourceContainer}</span>
                      </div>
                    </div>

                    <div className="pt-2 border-t border-[#F4F4F5] dark:border-[#27272A] flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => onPreviewItem(item)}
                        className="inline-flex items-center gap-1 text-xs font-medium text-[#52525B] dark:text-[#A1A1AA] hover:text-[#09090B] dark:hover:text-[#FAFAFA] transition-colors whitespace-nowrap"
                      >
                        <Eye className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>Preview</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => onDownloadSingle(item)}
                        className="inline-flex items-center gap-1 text-xs font-medium text-[#1D4ED8] dark:text-[#60A5FA] hover:text-[#1E40AF] dark:hover:text-[#93C5FD] transition-colors whitespace-nowrap"
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
          <div className="overflow-x-auto -mx-4 sm:-mx-5 px-4 sm:px-5">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[#E4E4E7] dark:border-[#27272A] text-xs font-medium text-[#71717A] dark:text-[#A1A1AA]">
                  <th className="py-2 pr-3 w-8">
                    <span className="sr-only">Select</span>
                  </th>
                  <th className="py-2 pr-4">File</th>
                  <th className="py-2 pr-4">Source</th>
                  <th className="py-2 pr-4">Format</th>
                  <th className="py-2 pr-4 text-right">Size</th>
                  <th className="py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#F4F4F5] dark:divide-[#27272A] text-sm">
                {pageItems.map((item) => {
                  const isSelected = selectedIds.has(item.id);
                  return (
                    <tr
                      key={item.id}
                      className={`transition-colors ${
                        isSelected
                          ? 'bg-[#EFF6FF]/60 dark:bg-[#1E3A8A]/20'
                          : 'hover:bg-[#FAFAFA] dark:hover:bg-[#18181B]/70'
                      }`}
                    >
                      <td className="py-2 pr-3">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => onToggleSelect(item.id)}
                          aria-label={`Select ${item.filename}`}
                          className="w-4 h-4 rounded-xs border-[#D4D4D8] dark:border-[#3F3F46] accent-[#1D4ED8] dark:accent-[#3B82F6]"
                        />
                      </td>
                      <td className="py-2 pr-4 max-w-[300px]">
                        <div className="flex items-center gap-3">
                          <button
                            type="button"
                            onClick={() => onPreviewItem(item)}
                            aria-label={`Preview ${item.title}`}
                            className="w-9 h-9 rounded-xs overflow-hidden bg-[#F4F4F5] dark:bg-[#18181B] shrink-0 border border-[#E4E4E7] dark:border-[#27272A]"
                          >
                            <MediaThumbnail item={item} aspectClass="aspect-square" />
                          </button>
                          <div className="min-w-0">
                            <p className="text-xs font-medium text-[#09090B] dark:text-[#FAFAFA] truncate">
                              {item.title}
                            </p>
                            <p className="text-[11px] font-mono text-[#71717A] dark:text-[#A1A1AA] truncate">
                              {item.filename}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="py-2 pr-4 text-xs text-[#52525B] dark:text-[#D4D4D8] whitespace-nowrap">
                        {item.sourceContainer}
                      </td>
                      <td className="py-2 pr-4 text-xs font-mono text-[#52525B] dark:text-[#A1A1AA] whitespace-nowrap">
                        {formatContentLabel(item)} · {item.extension.toUpperCase()}
                      </td>
                      <td className="py-2 pr-4 text-xs font-mono tabular-nums text-[#71717A] dark:text-[#A1A1AA] text-right whitespace-nowrap">
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
                          <span>Load all</span>
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
                          {isAuth ? 'Session Required' : 'Unable to Fetch'}
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
