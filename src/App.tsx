import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, X, XCircle } from 'lucide-react';
import type {
  BatchExtractResponse,
  CapabilitiesResponse,
  ExtractionJob,
  MediaItem,
  Platform,
  ZipOptions,
} from './types';
import { TopBar } from './components/TopBar';
import { IntakeRail, type IntakeMode } from './components/IntakeRail';
import { StagingDeck, type MediaTypeFilter } from './components/StagingDeck';
import { LightboxModal } from './components/LightboxModal';
import { buildProxyUrl } from './components/MediaThumbnail';

interface ToastState {
  tone: 'success' | 'error';
  message: string;
}

/**
 * Packs selected items into video-aware ZIP parts so 600+ HD videos
 * (e.g. RedGIFs clips) never exceed the server's 300 MB per-ZIP cap.
 * Pure images pack up to maxImageItems (50/part); pure videos pack up to maxVideoItems (12/part).
 */
function buildSmartZipChunks(
  chosenItems: MediaItem[],
  maxImageItems: number,
  maxVideoItems: number,
): MediaItem[][] {
  const chunks: MediaItem[][] = [];
  let current: MediaItem[] = [];
  let weight = 0;
  const videoWeight = maxImageItems / Math.max(maxVideoItems, 1);

  for (const item of chosenItems) {
    const itemWeight = item.mediaType === 'video' ? videoWeight : 1;
    if (
      current.length > 0 &&
      (current.length >= maxImageItems || weight + itemWeight > maxImageItems + 0.01)
    ) {
      chunks.push(current);
      current = [];
      weight = 0;
    }
    current.push(item);
    weight += itemWeight;
  }

  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

export default function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [activePlatform, setActivePlatform] = useState<Platform>('instagram');
  const [intakeMode, setIntakeMode] = useState<IntakeMode>('single');
  const [inputsByPlatform, setInputsByPlatform] = useState<Record<Platform, string>>({
    instagram: '',
    reddit: '',
    redgifs: '',
  });
  const [subredditLimit, setSubredditLimit] = useState(50);
  const [subredditSort, setSubredditSort] = useState<'hot' | 'top' | 'new'>('new');
  const [zipOptions, setZipOptions] = useState<ZipOptions>({
    organizeByFolder: true,
    includeMetadataJson: false,
  });

  const [jobs, setJobs] = useState<ExtractionJob[]>([]);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const [typeFilter, setTypeFilter] = useState<MediaTypeFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState<'grid' | 'table'>('grid');
  const [lightboxItemId, setLightboxItemId] = useState<string | null>(null);

  const [isExtracting, setIsExtracting] = useState(false);
  const [loadingMoreJobUrl, setLoadingMoreJobUrl] = useState<string | null>(null);
  const [autoLoadingJobUrl, setAutoLoadingJobUrl] = useState<string | null>(null);
  const stopAutoLoadRef = useRef(false);

  const [isBundlingZip, setIsBundlingZip] = useState(false);
  const [zipProgressLabel, setZipProgressLabel] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<CapabilitiesResponse | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);

  const maxZipImages = capabilities?.maxZipItems ?? 50;
  const maxZipVideos = capabilities?.maxZipVideoItems ?? 12;

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  function showToast(tone: 'success' | 'error', message: string) {
    setToast({ tone, message });
  }

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4200);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    let active = true;
    fetch('/api/capabilities')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: CapabilitiesResponse | null) => {
        if (active && data) setCapabilities(data);
      })
      .catch(() => {
        // ignore transient startup error
      });
    return () => {
      active = false;
    };
  }, []);

  const jobPlatformById = useMemo(() => {
    const map = new Map<string, Platform | null>();
    for (const j of jobs) {
      map.set(j.id, j.platform);
    }
    return map;
  }, [jobs]);

  const countsByPlatform = useMemo(() => {
    const counts: Record<Platform, number> = {
      instagram: 0,
      reddit: 0,
      redgifs: 0,
    };
    for (const item of items) {
      const target = jobPlatformById.get(item.jobId) || item.platform;
      counts[target] += 1;
    }
    return counts;
  }, [items, jobPlatformById]);

  const activePlatformItems = useMemo(
    () =>
      items.filter((item) => {
        const jobPlatform = jobPlatformById.get(item.jobId);
        return (jobPlatform || item.platform) === activePlatform;
      }),
    [items, jobPlatformById, activePlatform],
  );

  const activePlatformJobs = useMemo(
    () => jobs.filter((job) => job.platform === activePlatform),
    [jobs, activePlatform],
  );

  const activeSelectedItems = useMemo(
    () => activePlatformItems.filter((item) => selectedIds.has(item.id)),
    [activePlatformItems, selectedIds],
  );

  const activeZipPartCount = useMemo(
    () =>
      buildSmartZipChunks(activeSelectedItems, maxZipImages, maxZipVideos).length,
    [activeSelectedItems, maxZipImages, maxZipVideos],
  );

  async function runExtraction(urls: string[]) {
    if (urls.length === 0 || isExtracting || loadingMoreJobUrl || autoLoadingJobUrl) {
      return;
    }
    setIsExtracting(true);

    try {
      const response = await fetch('/api/extract/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          urls,
          subredditLimit,
          subredditSort,
        }),
      });

      if (!response.ok) {
        const errPayload = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(errPayload.error || `Extraction failed (${response.status})`);
      }

      const data = (await response.json()) as BatchExtractResponse;

      // Auto-switch to the extracted platform if the user pasted another platform's URL
      const firstResolvedPlatform = data.jobs[0]?.platform;
      if (firstResolvedPlatform && firstResolvedPlatform !== activePlatform) {
        setActivePlatform(firstResolvedPlatform);
      }

      setJobs((prev) => {
        const replacedUrls = new Set(data.jobs.map((j) => j.sourceUrl));
        return [...data.jobs, ...prev.filter((j) => !replacedUrls.has(j.sourceUrl))];
      });

      setItems((prev) => {
        const existingMediaUrls = new Set(prev.map((m) => m.mediaUrl));
        const fresh = data.items.filter((m) => !existingMediaUrls.has(m.mediaUrl));
        return [...fresh, ...prev];
      });

      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const item of data.items) {
          next.add(item.id);
        }
        return next;
      });

      if (data.items.length > 0) {
        showToast(
          'success',
          `Loaded ${data.items.length} ${data.items.length === 1 ? 'file' : 'files'}.`,
        );
      } else {
        const hasAuth = data.jobs.some((j) => j.status === 'auth_required');
        showToast(
          'error',
          hasAuth
            ? 'Instagram session required for this link.'
            : 'No downloadable media found.',
        );
      }
    } catch (err) {
      showToast(
        'error',
        err instanceof Error ? err.message : 'Unable to fetch media.',
      );
    } finally {
      setIsExtracting(false);
    }
  }

  async function fetchNextPageForJob(job: ExtractionJob): Promise<ExtractionJob | null> {
    if (!job.nextCursor) return null;
    const nextPage = (job.pageNumber || 1) + 1;

    const response = await fetch('/api/extract/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urls: [job.sourceUrl],
        subredditLimit,
        subredditSort,
        cursor: job.nextCursor,
        pageNumber: nextPage,
      }),
    });

    if (!response.ok) {
      const errPayload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      throw new Error(errPayload.error || `Pagination failed (${response.status})`);
    }

    const data = (await response.json()) as BatchExtractResponse;
    const updatedJob = data.jobs[0];

    let addedCount = 0;
    const addedIds: string[] = [];
    // Attach newly fetched items to the original jobId so platform scoping stays unified
    const normalizedItems = data.items.map((item) => ({
      ...item,
      jobId: job.id,
    }));

    setItems((prev) => {
      const existingMediaUrls = new Set(prev.map((m) => m.mediaUrl));
      const fresh = normalizedItems.filter((m) => !existingMediaUrls.has(m.mediaUrl));
      addedCount = fresh.length;
      fresh.forEach((m) => addedIds.push(m.id));
      return [...prev, ...fresh];
    });

    if (addedIds.length > 0) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        addedIds.forEach((id) => next.add(id));
        return next;
      });
    }

    const mergedJob: ExtractionJob = {
      ...job,
      hasMore: Boolean(updatedJob?.hasMore && data.items.length > 0),
      nextCursor: updatedJob?.nextCursor,
      pageNumber: nextPage,
      itemCount: job.itemCount + addedCount,
      totalAvailable: updatedJob?.totalAvailable ?? job.totalAvailable,
    };

    setJobs((prev) =>
      prev.map((existing) =>
        existing.sourceUrl === job.sourceUrl ? mergedJob : existing,
      ),
    );

    return mergedJob;
  }

  async function handleLoadMore(job: ExtractionJob) {
    if (!job.nextCursor || isExtracting || loadingMoreJobUrl || autoLoadingJobUrl) {
      return;
    }
    setLoadingMoreJobUrl(job.sourceUrl);
    try {
      const updated = await fetchNextPageForJob(job);
      if (updated) {
        const delta = updated.itemCount - job.itemCount;
        showToast(
          'success',
          delta > 0
            ? `Page ${updated.pageNumber} loaded (+${delta} files).`
            : 'Reached the end of available media.',
        );
      }
    } catch (err) {
      showToast(
        'error',
        err instanceof Error ? err.message : 'Unable to load next page.',
      );
    } finally {
      setLoadingMoreJobUrl(null);
    }
  }

  async function handleLoadAll(initialJob: ExtractionJob) {
    if (!initialJob.nextCursor || isExtracting || loadingMoreJobUrl || autoLoadingJobUrl) {
      return;
    }
    stopAutoLoadRef.current = false;
    setAutoLoadingJobUrl(initialJob.sourceUrl);

    let current: ExtractionJob = initialJob;
    let pagesWalked = 0;
    const MAX_AUTO_PAGES = 30; // up to ~2,400+ items safely

    try {
      while (
        !stopAutoLoadRef.current &&
        current.hasMore &&
        current.nextCursor &&
        pagesWalked < MAX_AUTO_PAGES
      ) {
        const next = await fetchNextPageForJob(current);
        pagesWalked += 1;
        if (!next || !next.hasMore || !next.nextCursor) {
          if (next) current = next;
          break;
        }
        current = next;
        // Polite delay between pages to avoid upstream rate limits
        await new Promise((r) => setTimeout(r, 450));
      }

      showToast(
        'success',
        stopAutoLoadRef.current
          ? `Stopped at ${current.itemCount} loaded files.`
          : `Loaded ${current.itemCount} files total.`,
      );
    } catch (err) {
      showToast(
        'error',
        err instanceof Error
          ? `${err.message} (${current.itemCount} files kept)`
          : 'Stopped loading pages.',
      );
    } finally {
      setAutoLoadingJobUrl(null);
      stopAutoLoadRef.current = false;
    }
  }

  function handleStopLoadAll() {
    stopAutoLoadRef.current = true;
  }

  function handleToggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function handleSelectVisible(visibleIds: string[]) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      visibleIds.forEach((id) => next.add(id));
      return next;
    });
  }

  function handleDeselectPlatform() {
    const platformIdSet = new Set(activePlatformItems.map((i) => i.id));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      platformIdSet.forEach((id) => next.delete(id));
      return next;
    });
  }

  function handleClearPlatform() {
    const platformIdSet = new Set(activePlatformItems.map((i) => i.id));
    setInputsByPlatform((prev) => ({ ...prev, [activePlatform]: '' }));
    setJobs((prev) => prev.filter((j) => j.platform !== activePlatform));
    setItems((prev) => prev.filter((i) => !platformIdSet.has(i.id)));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      platformIdSet.forEach((id) => next.delete(id));
      return next;
    });
    setTypeFilter('all');
    setSearchQuery('');
    setLightboxItemId(null);
    showToast('success', 'Cleared.');
  }

  function handleDownloadSingle(item: MediaItem) {
    const link = document.createElement('a');
    link.href = buildProxyUrl(item.mediaUrl, {
      download: true,
      filename: item.filename,
    });
    link.download = item.filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast('success', `Downloading ${item.filename}`);
  }

  function handleExportUrls() {
    if (activeSelectedItems.length === 0) return;
    const lines = activeSelectedItems.map((item) => item.mediaUrl).join('\n') + '\n';
    const blob = new Blob([lines], { type: 'text/plain;charset=utf-8' });
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = `pulldeck-${activePlatform}-${activeSelectedItems.length}-urls.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
    showToast(
      'success',
      `Exported ${activeSelectedItems.length} direct media URLs.`,
    );
  }

  async function handleDownloadZip() {
    if (activeSelectedItems.length === 0 || isBundlingZip) return;

    const chunks = buildSmartZipChunks(
      activeSelectedItems,
      maxZipImages,
      maxZipVideos,
    );

    setIsBundlingZip(true);

    try {
      for (let partIdx = 0; partIdx < chunks.length; partIdx += 1) {
        const chunk = chunks[partIdx];
        const partNumber = partIdx + 1;
        const isMultiPart = chunks.length > 1;
        const partLabel = isMultiPart
          ? `part-${partNumber}-of-${chunks.length}`
          : undefined;

        setZipProgressLabel(
          isMultiPart
            ? `ZIP Part ${partNumber}/${chunks.length}...`
            : 'Packaging ZIP...',
        );

        const response = await fetch('/api/download/zip', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            items: chunk.map((item) => ({
              id: item.id,
              platform: item.platform,
              sourceContainer: item.sourceContainer,
              author: item.author,
              title: item.title,
              mediaUrl: item.mediaUrl,
              sourceUrl: item.sourceUrl,
              filename: item.filename,
              mediaType: item.mediaType,
            })),
            options: zipOptions,
            partLabel,
          }),
        });

        if (!response.ok) {
          const errPayload = (await response.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(
            errPayload.error ||
              `ZIP bundling failed on part ${partNumber} (${response.status})`,
          );
        }

        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = isMultiPart
          ? `pulldeck-${activePlatform}-part-${partNumber}-of-${chunks.length}.zip`
          : `pulldeck-${activePlatform}-${chunk.length}-files.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(blobUrl), 8000);

        if (partIdx < chunks.length - 1) {
          await new Promise((r) => setTimeout(r, 450));
        }
      }

      showToast(
        'success',
        chunks.length > 1
          ? `Downloaded ${chunks.length} ZIP parts (${activeSelectedItems.length} files).`
          : `Downloaded ZIP (${activeSelectedItems.length} ${activeSelectedItems.length === 1 ? 'file' : 'files'}).`,
      );
    } catch (err) {
      showToast(
        'error',
        err instanceof Error ? err.message : 'Failed to build ZIP bundle.',
      );
    } finally {
      setIsBundlingZip(false);
      setZipProgressLabel(null);
    }
  }

  const lightboxIndex = lightboxItemId
    ? activePlatformItems.findIndex((i) => i.id === lightboxItemId)
    : -1;

  return (
    <div className="min-h-screen flex flex-col bg-[#FAFAFA] dark:bg-[#09090B] text-[#09090B] dark:text-[#FAFAFA]">
      <TopBar
        activePlatform={activePlatform}
        onPlatformChange={(p) => {
          setActivePlatform(p);
          setTypeFilter('all');
          setSearchQuery('');
        }}
        countsByPlatform={countsByPlatform}
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
      />

      <main className="flex-1 max-w-[1200px] w-full mx-auto px-4 sm:px-8 py-6 flex flex-col gap-5">
        <IntakeRail
          platform={activePlatform}
          mode={intakeMode}
          onModeChange={setIntakeMode}
          rawInput={inputsByPlatform[activePlatform]}
          onRawInputChange={(val) =>
            setInputsByPlatform((prev) => ({ ...prev, [activePlatform]: val }))
          }
          subredditLimit={subredditLimit}
          onSubredditLimitChange={setSubredditLimit}
          subredditSort={subredditSort}
          onSubredditSortChange={setSubredditSort}
          zipOptions={zipOptions}
          onZipOptionsChange={setZipOptions}
          isExtracting={isExtracting}
          onExtract={runExtraction}
          capabilities={capabilities}
        />

        <StagingDeck
          platform={activePlatform}
          items={activePlatformItems}
          jobs={activePlatformJobs}
          selectedIds={selectedIds}
          typeFilter={typeFilter}
          onTypeFilterChange={setTypeFilter}
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          isExtracting={isExtracting}
          loadingMoreJobUrl={loadingMoreJobUrl}
          autoLoadingJobUrl={autoLoadingJobUrl}
          isBundlingZip={isBundlingZip}
          zipProgressLabel={zipProgressLabel}
          zipPartCount={activeZipPartCount}
          selectedCount={activeSelectedItems.length}
          onToggleSelect={handleToggleSelect}
          onSelectVisible={handleSelectVisible}
          onDeselectPlatform={handleDeselectPlatform}
          onClearPlatform={handleClearPlatform}
          onPreviewItem={(item) => setLightboxItemId(item.id)}
          onDownloadSingle={handleDownloadSingle}
          onDownloadZip={handleDownloadZip}
          onExportUrls={handleExportUrls}
          onRetryJob={(url) => runExtraction([url])}
          onLoadMore={handleLoadMore}
          onLoadAll={handleLoadAll}
          onStopLoadAll={handleStopLoadAll}
        />
      </main>

      {lightboxIndex >= 0 && (
        <LightboxModal
          items={activePlatformItems}
          activeIndex={lightboxIndex}
          selectedIds={selectedIds}
          onClose={() => setLightboxItemId(null)}
          onNavigate={(idx) =>
            setLightboxItemId(activePlatformItems[idx]?.id ?? null)
          }
          onToggleSelect={handleToggleSelect}
          onDownloadSingle={handleDownloadSingle}
        />
      )}

      {toast && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-5 right-5 z-50 max-w-sm bg-white dark:bg-[#18181B] border border-[#E4E4E7] dark:border-[#27272A] rounded-lg px-4 py-3 shadow-sm flex items-center gap-3 text-sm"
        >
          {toast.tone === 'success' ? (
            <CheckCircle2
              className="w-4 h-4 text-[#15803D] dark:text-[#4ADE80] shrink-0"
              aria-hidden="true"
            />
          ) : (
            <XCircle
              className="w-4 h-4 text-[#B91C1C] dark:text-[#F87171] shrink-0"
              aria-hidden="true"
            />
          )}
          <span className="text-[#09090B] dark:text-[#FAFAFA] text-xs font-medium leading-snug">
            {toast.message}
          </span>
          <button
            type="button"
            onClick={() => setToast(null)}
            aria-label="Dismiss notification"
            className="text-[#71717A] dark:text-[#A1A1AA] hover:text-[#09090B] dark:hover:text-[#FAFAFA] ml-1 shrink-0"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
