import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, X, XCircle } from 'lucide-react';
import type {
  BatchExtractResponse,
  CapabilitiesResponse,
  ContentType,
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
import {
  canHashItemThumbnail,
  computeThumbnailDHash,
  deduplicateRedditItems,
} from './utils/redditDedup';

interface ToastState {
  tone: 'success' | 'error';
  message: string;
}

const AUTO_STREAM_PROFILE_TYPES = new Set<ContentType>([
  'ig_profile',
  'reddit_user',
  'redgifs_profile',
]);

function getAdaptiveDelayMs(platform: Platform | null, pagesWalked: number): number {
  if (platform === 'redgifs') {
    return pagesWalked >= 6 ? 700 : 350;
  }
  if (platform === 'instagram') {
    return pagesWalked >= 4 ? 1400 : 800;
  }
  // Reddit
  return pagesWalked >= 5 ? 900 : 450;
}

/**
 * Uniquely identifies an extracted media entry so retries never duplicate the same submission,
 * while separate Reddit reposts sharing the same mediaUrl still reach the earliest-original dedup engine.
 */
function itemSubmissionKey(item: MediaItem, jobPlatform: Platform | null): string {
  const effectivePlatform = jobPlatform || item.platform;
  if (effectivePlatform === 'reddit') {
    const postKey = item.postId || item.sourceUrl;
    return `reddit::${postKey}::${item.indexInGroup}::${item.mediaUrl}`;
  }
  return item.mediaUrl;
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
  const [zipOptions, setZipOptions] = useState<ZipOptions>({
    organizeByFolder: true,
    includeMetadataJson: false,
  });

  const [jobs, setJobs] = useState<ExtractionJob[]>([]);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Reddit multi-signal deduplication state (strictly in-memory)
  const [showRedditDuplicates, setShowRedditDuplicates] = useState(false);
  const [visualHashes, setVisualHashes] = useState<Map<string, bigint | null>>(
    () => new Map(),
  );
  const hashedIdsRef = useRef<Set<string>>(new Set());
  const inFlightHashIdsRef = useRef<Set<string>>(new Set());

  const [typeFilter, setTypeFilter] = useState<MediaTypeFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState<'grid' | 'table'>('grid');
  const [lightboxItemId, setLightboxItemId] = useState<string | null>(null);

  const [isExtracting, setIsExtracting] = useState(false);
  const [loadingMoreJobUrl, setLoadingMoreJobUrl] = useState<string | null>(null);
  const [autoLoadingJobUrl, setAutoLoadingJobUrl] = useState<string | null>(null);
  const stopAutoLoadRef = useRef(false);
  const autoLoadRunIdRef = useRef(0);

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

  const redditItems = useMemo(
    () =>
      items.filter((item) => {
        const jobPlatform = jobPlatformById.get(item.jobId);
        return (jobPlatform || item.platform) === 'reddit';
      }),
    [items, jobPlatformById],
  );

  const redditDedup = useMemo(
    () => deduplicateRedditItems(redditItems, visualHashes),
    [redditItems, visualHashes],
  );

  // Progressive background visual thumbnail hashing (Layer 3 dHash) for Reddit items
  useEffect(() => {
    const hashable = redditItems.filter(
      (item) =>
        canHashItemThumbnail(item) &&
        !hashedIdsRef.current.has(item.id) &&
        !inFlightHashIdsRef.current.has(item.id),
    );
    if (hashable.length === 0) return;

    let cancelled = false;
    let cursor = 0;
    const CONCURRENCY = 4;
    const pendingBatch = new Map<string, bigint | null>();

    const flushBatch = () => {
      if (pendingBatch.size === 0 || cancelled) return;
      const entries = Array.from(pendingBatch.entries());
      pendingBatch.clear();
      setVisualHashes((prev) => {
        const next = new Map(prev);
        for (const [id, hash] of entries) {
          next.set(id, hash);
        }
        return next;
      });
    };

    async function worker() {
      while (!cancelled && cursor < hashable.length) {
        const item = hashable[cursor];
        cursor += 1;
        if (hashedIdsRef.current.has(item.id) || inFlightHashIdsRef.current.has(item.id)) {
          continue;
        }
        inFlightHashIdsRef.current.add(item.id);
        const hash = await computeThumbnailDHash(buildProxyUrl(item.thumbnailUrl));
        inFlightHashIdsRef.current.delete(item.id);
        if (cancelled) return;
        hashedIdsRef.current.add(item.id);
        pendingBatch.set(item.id, hash);
        if (pendingBatch.size >= 8) {
          flushBatch();
          await new Promise((r) => setTimeout(r, 30));
        }
      }
    }

    const workers = Array.from(
      { length: Math.min(CONCURRENCY, hashable.length) },
      () => worker(),
    );
    void Promise.all(workers).then(() => {
      flushBatch();
    });

    return () => {
      cancelled = true;
    };
  }, [redditItems]);

  const redditVisualScanProgress = useMemo(() => {
    const hashableTotal = redditItems.filter(canHashItemThumbnail).length;
    if (hashableTotal <= 1) return null;
    let scanned = 0;
    for (const item of redditItems) {
      if (canHashItemThumbnail(item) && visualHashes.has(item.id)) {
        scanned += 1;
      }
    }
    if (scanned >= hashableTotal) return null;
    return { scanned, total: hashableTotal };
  }, [redditItems, visualHashes]);

  // Keep selection synced with earliest-original promotion & hidden duplicate exclusion
  useEffect(() => {
    if (redditItems.length === 0) return;

    setSelectedIds((prev) => {
      let changed = false;
      const next = new Set(prev);

      for (const [itemId, ann] of redditDedup.annotations.entries()) {
        if (!ann.isDuplicate) continue;
        if (next.has(itemId)) {
          // Transfer selection to the true earliest original when superseded
          if (!next.has(ann.canonicalId)) {
            next.add(ann.canonicalId);
            changed = true;
          }
          // When duplicates are hidden, remove hidden duplicate IDs from active selection
          if (!showRedditDuplicates) {
            next.delete(itemId);
            changed = true;
          }
        }
      }

      return changed ? next : prev;
    });
  }, [redditDedup, redditItems.length, showRedditDuplicates]);

  const countsByPlatform = useMemo(() => {
    const counts: Record<Platform, number> = {
      instagram: 0,
      reddit: 0,
      redgifs: 0,
    };
    for (const item of items) {
      const target = jobPlatformById.get(item.jobId) || item.platform;
      if (
        target === 'reddit' &&
        !showRedditDuplicates &&
        redditDedup.hiddenDuplicateIds.has(item.id)
      ) {
        continue;
      }
      counts[target] += 1;
    }
    return counts;
  }, [items, jobPlatformById, showRedditDuplicates, redditDedup.hiddenDuplicateIds]);

  const activePlatformItems = useMemo(
    () =>
      items.filter((item) => {
        const jobPlatform = jobPlatformById.get(item.jobId);
        const resolvedPlatform = jobPlatform || item.platform;
        if (resolvedPlatform !== activePlatform) return false;
        if (
          activePlatform === 'reddit' &&
          !showRedditDuplicates &&
          redditDedup.hiddenDuplicateIds.has(item.id)
        ) {
          return false;
        }
        return true;
      }),
    [
      items,
      jobPlatformById,
      activePlatform,
      showRedditDuplicates,
      redditDedup.hiddenDuplicateIds,
    ],
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

  async function fetchNextPageForJob(
    job: ExtractionJob,
    runId?: number,
  ): Promise<{ mergedJob: ExtractionJob; addedCount: number } | null> {
    if (!job.nextCursor) return null;
    const nextPage = (job.pageNumber || 1) + 1;

    const response = await fetch('/api/extract/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urls: [job.sourceUrl],
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
    // If cancelled/cleared while request was in flight, discard cleanly
    if (runId !== undefined && runId !== autoLoadRunIdRef.current) {
      return null;
    }

    const updatedJob = data.jobs[0];
    let addedCount = 0;
    const addedIds: string[] = [];

    // Attach newly fetched items to the original jobId so platform scoping stays unified
    const normalizedItems = data.items.map((item) => ({
      ...item,
      jobId: job.id,
    }));

    setItems((prev) => {
      const existingKeys = new Set(
        prev.map((m) => itemSubmissionKey(m, jobPlatformById.get(m.jobId) ?? null)),
      );
      const fresh = normalizedItems.filter((m) => {
        const key = itemSubmissionKey(m, job.platform);
        if (existingKeys.has(key)) return false;
        existingKeys.add(key);
        return true;
      });
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
      hasMore: Boolean(updatedJob?.hasMore && updatedJob?.nextCursor),
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

    return { mergedJob, addedCount };
  }

  /**
   * Adaptive Auto-Pagination Engine:
   * Streams remaining pages with platform-aware pacing, transient retry backoff,
   * and instant Stop / Clear cancellation across Instagram, Reddit, and RedGIFs.
   */
  async function streamRemainingPages(initialJob: ExtractionJob) {
    if (!initialJob.nextCursor) return;

    const runId = autoLoadRunIdRef.current + 1;
    autoLoadRunIdRef.current = runId;
    stopAutoLoadRef.current = false;
    setAutoLoadingJobUrl(initialJob.sourceUrl);

    let current: ExtractionJob = initialJob;
    let pagesWalked = 0;
    let consecutiveEmptyPages = 0;
    const MAX_AUTO_PAGES = 60;

    try {
      while (
        !stopAutoLoadRef.current &&
        runId === autoLoadRunIdRef.current &&
        current.hasMore &&
        current.nextCursor &&
        pagesWalked < MAX_AUTO_PAGES
      ) {
        await new Promise((r) =>
          setTimeout(r, getAdaptiveDelayMs(current.platform, pagesWalked)),
        );
        if (stopAutoLoadRef.current || runId !== autoLoadRunIdRef.current) {
          break;
        }

        let stepResult: { mergedJob: ExtractionJob; addedCount: number } | null = null;
        try {
          stepResult = await fetchNextPageForJob(current, runId);
        } catch {
          // Adaptive single retry with gentle backoff for transient rate limits
          if (stopAutoLoadRef.current || runId !== autoLoadRunIdRef.current) {
            break;
          }
          await new Promise((r) => setTimeout(r, 1800));
          if (stopAutoLoadRef.current || runId !== autoLoadRunIdRef.current) {
            break;
          }
          stepResult = await fetchNextPageForJob(current, runId);
        }

        if (!stepResult || runId !== autoLoadRunIdRef.current) {
          break;
        }

        pagesWalked += 1;
        current = stepResult.mergedJob;

        if (stepResult.addedCount === 0) {
          consecutiveEmptyPages += 1;
          if (consecutiveEmptyPages >= 3) break;
        } else {
          consecutiveEmptyPages = 0;
        }

        if (!current.hasMore || !current.nextCursor) {
          break;
        }
      }

      if (runId === autoLoadRunIdRef.current) {
        showToast(
          'success',
          stopAutoLoadRef.current
            ? `Paused at ${current.itemCount} fetched posts.`
            : `Loaded ${current.itemCount} posts total.`,
        );
      }
    } catch (err) {
      if (runId === autoLoadRunIdRef.current) {
        showToast(
          'error',
          err instanceof Error
            ? `${err.message} (${current.itemCount} posts kept)`
            : `Paused at ${current.itemCount} posts.`,
        );
      }
    } finally {
      if (runId === autoLoadRunIdRef.current) {
        setAutoLoadingJobUrl(null);
        stopAutoLoadRef.current = false;
      }
    }
  }

  async function runExtraction(urls: string[]) {
    if (urls.length === 0 || isExtracting || loadingMoreJobUrl) {
      return;
    }

    // Cancel any previous background auto-stream before starting a fresh fetch
    autoLoadRunIdRef.current += 1;
    stopAutoLoadRef.current = true;
    setAutoLoadingJobUrl(null);
    setIsExtracting(true);

    try {
      const response = await fetch('/api/extract/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls }),
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

      const incomingPlatformByJob = new Map<string, Platform | null>();
      for (const j of data.jobs) {
        incomingPlatformByJob.set(j.id, j.platform);
      }

      setJobs((prev) => {
        const replacedUrls = new Set(data.jobs.map((j) => j.sourceUrl));
        return [...data.jobs, ...prev.filter((j) => !replacedUrls.has(j.sourceUrl))];
      });

      setItems((prev) => {
        const existingKeys = new Set(
          prev.map((m) => itemSubmissionKey(m, jobPlatformById.get(m.jobId) ?? null)),
        );
        const fresh = data.items.filter((m) => {
          const key = itemSubmissionKey(
            m,
            incomingPlatformByJob.get(m.jobId) ?? m.platform,
          );
          if (existingKeys.has(key)) return false;
          existingKeys.add(key);
          return true;
        });
        return [...fresh, ...prev];
      });

      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const item of data.items) {
          next.add(item.id);
        }
        return next;
      });

      // Automatically continue streaming remaining pages for finite User Profiles
      // (Instagram profiles, Reddit user profiles, RedGIFs profiles)
      const autoStreamProfileJob =
        data.jobs.length === 1
          ? data.jobs.find(
              (j) =>
                j.status === 'ready' &&
                j.hasMore &&
                Boolean(j.nextCursor) &&
                AUTO_STREAM_PROFILE_TYPES.has(j.contentType),
            )
          : undefined;

      if (data.items.length > 0) {
        if (autoStreamProfileJob) {
          const totalHint = autoStreamProfileJob.totalAvailable
            ? ` of ${autoStreamProfileJob.totalAvailable}`
            : '';
          showToast(
            'success',
            `Loaded ${data.items.length}${totalHint} — streaming remaining pages...`,
          );
          setIsExtracting(false);
          void streamRemainingPages(autoStreamProfileJob);
          return;
        }
        showToast(
          'success',
          `Loaded ${data.items.length} ${data.items.length === 1 ? 'file' : 'files'}.`,
        );
      } else {
        const firstIssue = data.jobs.find((j) => j.status !== 'ready');
        showToast(
          'error',
          firstIssue?.message || 'No downloadable media found.',
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

  async function handleLoadMore(job: ExtractionJob) {
    if (!job.nextCursor || isExtracting || loadingMoreJobUrl || autoLoadingJobUrl) {
      return;
    }
    setLoadingMoreJobUrl(job.sourceUrl);
    try {
      const result = await fetchNextPageForJob(job);
      if (result) {
        const { mergedJob, addedCount } = result;
        showToast(
          'success',
          addedCount > 0
            ? `Page ${mergedJob.pageNumber} loaded (+${addedCount} files).`
            : mergedJob.hasMore
              ? 'Page contained text-only posts — click Load more to continue.'
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
    await streamRemainingPages(initialJob);
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
    // Stop any background auto-stream running for this platform
    const activeJobMatchesPlatform = activePlatformJobs.some(
      (j) => j.sourceUrl === autoLoadingJobUrl,
    );
    if (activeJobMatchesPlatform) {
      autoLoadRunIdRef.current += 1;
      stopAutoLoadRef.current = true;
      setAutoLoadingJobUrl(null);
    }

    const allIdsForPlatform = new Set(
      items
        .filter((i) => (jobPlatformById.get(i.jobId) || i.platform) === activePlatform)
        .map((i) => i.id),
    );

    if (activePlatform === 'reddit') {
      setShowRedditDuplicates(false);
      allIdsForPlatform.forEach((id) => {
        hashedIdsRef.current.delete(id);
        inFlightHashIdsRef.current.delete(id);
      });
      setVisualHashes((prev) => {
        const next = new Map(prev);
        allIdsForPlatform.forEach((id) => next.delete(id));
        return next;
      });
    }

    setInputsByPlatform((prev) => ({ ...prev, [activePlatform]: '' }));
    setJobs((prev) => prev.filter((j) => j.platform !== activePlatform));
    setItems((prev) => prev.filter((i) => !allIdsForPlatform.has(i.id)));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      allIdsForPlatform.forEach((id) => next.delete(id));
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
          duplicateAnnotations={
            activePlatform === 'reddit' ? redditDedup.annotations : undefined
          }
          duplicateCount={
            activePlatform === 'reddit' ? redditDedup.duplicateCount : 0
          }
          showDuplicates={
            activePlatform === 'reddit' ? showRedditDuplicates : false
          }
          onToggleShowDuplicates={
            activePlatform === 'reddit'
              ? () => setShowRedditDuplicates((prev) => !prev)
              : undefined
          }
          visualScanProgress={
            activePlatform === 'reddit' ? redditVisualScanProgress : null
          }
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
