import crypto from 'node:crypto';
import type { ContentType, ExtractionJob, MediaItem } from '../../src/types.ts';
import { safeFetch, sanitizeFilename } from '../security.ts';
import {
  extractRedgifsClipById,
  extractRedgifsIdFromUrl,
} from './redgifs.ts';

const REDDIT_USER_AGENT =
  'web:pulldeck-media-studio:v1.0 (stateless bulk media archiver)';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface RedditPostData {
  id?: string;
  title?: string;
  author?: string;
  subreddit?: string;
  subreddit_name_prefixed?: string;
  permalink?: string;
  url?: string;
  url_overridden_by_dest?: string;
  post_hint?: string;
  score?: number;
  is_self?: boolean;
  is_gallery?: boolean;
  is_video?: boolean;
  created_utc?: number;
  gallery_data?: {
    items?: Array<{ media_id: string; caption?: string }>;
  };
  media_metadata?: Record<
    string,
    {
      status?: string;
      e?: string;
      m?: string;
      s?: {
        u?: string;
        gif?: string;
        mp4?: string;
        x?: number;
        y?: number;
      };
      p?: Array<{ u?: string; x?: number; y?: number }>;
    }
  >;
  secure_media?: {
    reddit_video?: {
      fallback_url?: string;
      height?: number;
      width?: number;
      duration?: number;
      has_audio?: boolean;
    };
  };
  media?: {
    reddit_video?: {
      fallback_url?: string;
      height?: number;
      width?: number;
      duration?: number;
      has_audio?: boolean;
    };
  };
  preview?: {
    images?: Array<{
      source?: { url?: string; width?: number; height?: number };
      resolutions?: Array<{ url?: string; width?: number; height?: number }>;
      variants?: {
        mp4?: { source?: { url?: string; width?: number; height?: number } };
        gif?: { source?: { url?: string; width?: number; height?: number } };
      };
    }>;
    reddit_video_preview?: {
      fallback_url?: string;
      width?: number;
      height?: number;
      duration?: number;
    };
  };
  crosspost_parent_list?: RedditPostData[];
}

function decodeHtmlUrl(url?: string): string {
  if (!url) return '';
  return url.replace(/&amp;/g, '&');
}

function inferExtensionFromUrl(url: string, fallback: string): string {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const match = pathname.match(/\.(jpg|jpeg|png|webp|gif|mp4|webm)$/i);
    if (match) return match[1].toLowerCase();
  } catch {
    // ignore
  }
  return fallback;
}

function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 42);
}

async function extractMediaFromPost(
  post: RedditPostData,
  jobId: string,
  strictMediaOnly = false,
): Promise<MediaItem[]> {
  const effectivePost =
    post.crosspost_parent_list && post.crosspost_parent_list.length > 0
      ? {
          ...post.crosspost_parent_list[0],
          title: post.title || post.crosspost_parent_list[0].title,
          subreddit: post.subreddit || post.crosspost_parent_list[0].subreddit,
          permalink: post.permalink || post.crosspost_parent_list[0].permalink,
        }
      : post;

  const title = (effectivePost.title || 'Reddit Media Post').trim();
  const author = effectivePost.author ? `u/${effectivePost.author}` : 'u/unknown';
  const subreddit = effectivePost.subreddit
    ? `r/${effectivePost.subreddit}`
    : 'r/reddit';
  const sourceUrl = effectivePost.permalink
    ? `https://www.reddit.com${effectivePost.permalink}`
    : effectivePost.url || 'https://www.reddit.com';
  const createdAt = effectivePost.created_utc
    ? new Date(effectivePost.created_utc * 1000).toISOString()
    : undefined;
  const slug = slugifyTitle(title) || effectivePost.id || 'reddit_post';
  const items: MediaItem[] = [];

  // 0. Embedded RedGIFs clip inside Reddit post
  const destCandidate = decodeHtmlUrl(
    effectivePost.url_overridden_by_dest || effectivePost.url,
  );
  const redgifsId = extractRedgifsIdFromUrl(destCandidate);
  if (redgifsId) {
    const resolvedRedgif = await extractRedgifsClipById(redgifsId, jobId, {
      title,
      sourceUrl,
      sourceContainer: subreddit,
    });
    if (resolvedRedgif) {
      return [resolvedRedgif];
    }
  }

  // 1. Multi-image / animated Reddit Gallery
  if (
    effectivePost.is_gallery &&
    effectivePost.gallery_data?.items &&
    effectivePost.media_metadata
  ) {
    const galleryOrder = effectivePost.gallery_data.items;
    const resolvedSlides: Array<{
      mediaUrl: string;
      thumbnailUrl: string;
      mediaType: 'image' | 'video';
      ext: string;
      width?: number;
      height?: number;
    }> = [];

    for (const slide of galleryOrder) {
      const meta = effectivePost.media_metadata[slide.media_id];
      if (!meta || meta.status !== 'valid' || !meta.s) continue;

      const mp4 = decodeHtmlUrl(meta.s.mp4);
      const gif = decodeHtmlUrl(meta.s.gif);
      const signedImg = decodeHtmlUrl(meta.s.u);
      const mimeExt =
        meta.m?.split('/')[1]?.replace('jpeg', 'jpg').toLowerCase() || 'jpg';
      const directGalleryImg =
        /^[a-zA-Z0-9_-]+$/.test(slide.media_id) &&
        /^(jpg|jpeg|png|gif|webp)$/.test(mimeExt)
          ? `https://i.redd.it/${slide.media_id}.${mimeExt}`
          : signedImg;

      if (mp4) {
        resolvedSlides.push({
          mediaUrl: mp4,
          thumbnailUrl: signedImg || directGalleryImg || mp4,
          mediaType: 'video',
          ext: 'mp4',
          width: meta.s.x,
          height: meta.s.y,
        });
      } else if (gif) {
        resolvedSlides.push({
          mediaUrl: gif,
          thumbnailUrl: gif,
          mediaType: 'image',
          ext: 'gif',
          width: meta.s.x,
          height: meta.s.y,
        });
      } else if (directGalleryImg || signedImg) {
        const chosen = directGalleryImg || signedImg;
        resolvedSlides.push({
          mediaUrl: chosen,
          thumbnailUrl: chosen,
          mediaType: 'image',
          ext: inferExtensionFromUrl(chosen, mimeExt),
          width: meta.s.x,
          height: meta.s.y,
        });
      }
    }

    resolvedSlides.forEach((slide, idx) => {
      items.push({
        id: crypto.randomUUID(),
        jobId,
        platform: 'reddit',
        contentType: 'reddit_post',
        mediaType: slide.mediaType,
        title,
        author,
        sourceContainer: subreddit,
        sourceUrl,
        mediaUrl: slide.mediaUrl,
        thumbnailUrl: slide.thumbnailUrl,
        filename: sanitizeFilename(
          `${subreddit.replace('r/', '')}_${slug}_${String(idx + 1).padStart(2, '0')}`,
          slide.ext,
        ),
        extension: slide.ext,
        width: slide.width,
        height: slide.height,
        indexInGroup: idx + 1,
        groupSize: resolvedSlides.length,
        createdAt,
      });
    });

    if (items.length > 0) return items;
  }

  // 2. Reddit-hosted Video (v.redd.it)
  const redditVideo =
    effectivePost.secure_media?.reddit_video ||
    effectivePost.media?.reddit_video ||
    effectivePost.preview?.reddit_video_preview;

  if (redditVideo?.fallback_url) {
    const videoUrl = decodeHtmlUrl(redditVideo.fallback_url);
    const previewImg = decodeHtmlUrl(
      effectivePost.preview?.images?.[0]?.source?.url,
    );

    items.push({
      id: crypto.randomUUID(),
      jobId,
      platform: 'reddit',
      contentType: 'reddit_post',
      mediaType: 'video',
      title,
      author,
      sourceContainer: subreddit,
      sourceUrl,
      mediaUrl: videoUrl,
      thumbnailUrl: previewImg || videoUrl,
      filename: sanitizeFilename(`${subreddit.replace('r/', '')}_${slug}`, 'mp4'),
      extension: 'mp4',
      width: redditVideo.width,
      height: redditVideo.height,
      durationSec: redditVideo.duration,
      indexInGroup: 1,
      groupSize: 1,
      createdAt,
      hasAudioTrack:
        'has_audio' in redditVideo ? Boolean(redditVideo.has_audio) : undefined,
    });
    return items;
  }

  // 3. Animated MP4 preview variant
  const previewVariantMp4 = decodeHtmlUrl(
    effectivePost.preview?.images?.[0]?.variants?.mp4?.source?.url,
  );
  if (previewVariantMp4) {
    const previewImg = decodeHtmlUrl(
      effectivePost.preview?.images?.[0]?.source?.url,
    );
    const vSource = effectivePost.preview?.images?.[0]?.variants?.mp4?.source;
    items.push({
      id: crypto.randomUUID(),
      jobId,
      platform: 'reddit',
      contentType: 'reddit_post',
      mediaType: 'video',
      title,
      author,
      sourceContainer: subreddit,
      sourceUrl,
      mediaUrl: previewVariantMp4,
      thumbnailUrl: previewImg || previewVariantMp4,
      filename: sanitizeFilename(`${subreddit.replace('r/', '')}_${slug}`, 'mp4'),
      extension: 'mp4',
      width: vSource?.width,
      height: vSource?.height,
      indexInGroup: 1,
      groupSize: 1,
      createdAt,
    });
    return items;
  }

  // 4. Direct image URL (i.redd.it, i.imgur.com) or high-res Reddit preview image
  const destUrl = decodeHtmlUrl(
    effectivePost.url_overridden_by_dest || effectivePost.url,
  );
  const previewSource = effectivePost.preview?.images?.[0]?.source;
  const previewUrl = decodeHtmlUrl(previewSource?.url);

  const isDirectImage =
    /\.(jpg|jpeg|png|webp|gif)(\?.*)?$/i.test(destUrl) &&
    /(i\.redd\.it|preview\.redd\.it|i\.imgur\.com|redditmedia\.com)/i.test(destUrl);

  if (strictMediaOnly && !isDirectImage && effectivePost.post_hint !== 'image') {
    return items;
  }

  const chosenImage = isDirectImage ? destUrl : previewUrl;
  if (chosenImage) {
    const ext = inferExtensionFromUrl(chosenImage, 'jpg');
    items.push({
      id: crypto.randomUUID(),
      jobId,
      platform: 'reddit',
      contentType: 'reddit_post',
      mediaType: 'image',
      title,
      author,
      sourceContainer: subreddit,
      sourceUrl,
      mediaUrl: chosenImage,
      thumbnailUrl: isDirectImage ? chosenImage : previewUrl || chosenImage,
      filename: sanitizeFilename(`${subreddit.replace('r/', '')}_${slug}`, ext),
      extension: ext,
      width: previewSource?.width,
      height: previewSource?.height,
      indexInGroup: 1,
      groupSize: 1,
      createdAt,
    });
  }

  return items;
}

async function fetchDirectRedditJson(jsonUrl: string): Promise<unknown | null> {
  const candidates = [jsonUrl];
  if (jsonUrl.includes('www.reddit.com')) {
    candidates.push(jsonUrl.replace('www.reddit.com', 'old.reddit.com'));
  }

  for (const target of candidates) {
    try {
      const { response } = await safeFetch(
        target,
        'extract',
        {
          headers: {
            'User-Agent': REDDIT_USER_AGENT,
            Accept: 'application/json, text/plain, */*',
          },
        },
        4500,
      );

      if (response.ok) {
        return await response.json();
      }
      if (response.status === 404) {
        return null;
      }
    } catch {
      // Fall through to public index fallback
    }
  }

  return null;
}

async function fetchArcticShiftPage(
  query:
    | { kind: 'subreddit'; name: string }
    | { kind: 'user'; name: string }
    | { kind: 'id'; id: string },
  pageSize: number,
  beforeUtc?: number,
): Promise<RedditPostData[]> {
  let endpoint = '';
  const safePageSize = Math.min(Math.max(pageSize, 1), 100);
  const beforeParam =
    beforeUtc && Number.isFinite(beforeUtc) && beforeUtc > 0
      ? `&before=${Math.floor(beforeUtc)}`
      : '';

  if (query.kind === 'id') {
    endpoint = `https://arctic-shift.photon-reddit.com/api/posts/ids?ids=${encodeURIComponent(query.id)}`;
  } else if (query.kind === 'subreddit') {
    endpoint = `https://arctic-shift.photon-reddit.com/api/posts/search?subreddit=${encodeURIComponent(query.name)}&limit=${safePageSize}&sort=desc${beforeParam}`;
  } else {
    endpoint = `https://arctic-shift.photon-reddit.com/api/posts/search?author=${encodeURIComponent(query.name)}&limit=${safePageSize}&sort=desc${beforeParam}`;
  }

  const { response } = await safeFetch(
    endpoint,
    'extract',
    {
      headers: {
        'User-Agent': REDDIT_USER_AGENT,
        Accept: 'application/json',
      },
    },
    10000,
  );

  if (!response.ok) {
    throw new Error(`Reddit archive mirror returned HTTP ${response.status}.`);
  }

  const payload = (await response.json()) as { data?: RedditPostData[] };
  return Array.isArray(payload.data) ? payload.data : [];
}

function parseRedditTarget(
  rawUrl: string,
  contentType: ContentType,
): {
  kind: 'subreddit' | 'user' | 'id' | 'unknown';
  value: string;
} {
  const parsed = new URL(rawUrl);
  const host = parsed.hostname.toLowerCase();
  const cleanPath = parsed.pathname.replace(/\/+$/, '');

  if (host === 'redd.it' || host === 'www.redd.it') {
    const id = cleanPath.replace(/^\//, '').split('/')[0];
    return id ? { kind: 'id', value: id } : { kind: 'unknown', value: '' };
  }

  const galleryMatch = cleanPath.match(/^\/gallery\/([a-zA-Z0-9]+)/i);
  if (galleryMatch) return { kind: 'id', value: galleryMatch[1] };

  const commentMatch = cleanPath.match(/\/comments\/([a-zA-Z0-9]+)/i);
  if (commentMatch) return { kind: 'id', value: commentMatch[1] };

  const userMatch = cleanPath.match(/^\/(?:u|user)\/([^/]+)/i);
  if (contentType === 'reddit_user' || userMatch) {
    return userMatch
      ? { kind: 'user', value: userMatch[1] }
      : { kind: 'unknown', value: '' };
  }

  const subMatch = cleanPath.match(/^\/r\/([^/]+)/i);
  if (contentType === 'reddit_subreddit' || subMatch) {
    return subMatch
      ? { kind: 'subreddit', value: subMatch[1] }
      : { kind: 'unknown', value: '' };
  }

  return { kind: 'unknown', value: '' };
}

export async function extractRedditUrl(
  sourceUrl: string,
  contentType: ContentType,
  jobId: string,
  subredditLimit = 25,
  subredditSort: 'hot' | 'top' | 'new' = 'new',
  cursor?: string,
  pageNumber = 1,
): Promise<{ job: ExtractionJob; items: MediaItem[] }> {
  const safeLimit = Math.min(Math.max(Number(subredditLimit) || 25, 1), 100);

  try {
    const parsed = new URL(sourceUrl);
    const host = parsed.hostname.toLowerCase();

    if (host === 'i.redd.it') {
      const ext = inferExtensionFromUrl(sourceUrl, 'jpg');
      const item: MediaItem = {
        id: crypto.randomUUID(),
        jobId,
        platform: 'reddit',
        contentType: 'reddit_post',
        mediaType: ext === 'mp4' ? 'video' : 'image',
        title: 'Direct Reddit Media',
        author: 'u/reddit',
        sourceContainer: 'r/direct',
        sourceUrl,
        mediaUrl: sourceUrl,
        thumbnailUrl: sourceUrl,
        filename: sanitizeFilename(parsed.pathname.replace('/', ''), ext),
        extension: ext,
        indexInGroup: 1,
        groupSize: 1,
      };
      return {
        job: {
          id: jobId,
          sourceUrl,
          platform: 'reddit',
          contentType: 'reddit_post',
          contentLabel: 'Reddit Direct Media',
          status: 'ready',
          message: 'Extracted 1 direct media asset.',
          itemCount: 1,
          resolverUsed: 'Reddit Direct CDN',
          hasMore: false,
          pageNumber,
        },
        items: [item],
      };
    }

    let canonicalUrl = sourceUrl;
    if (host === 'v.redd.it' || /\/s\/[^/]+/i.test(parsed.pathname)) {
      try {
        const { finalUrl } = await safeFetch(
          sourceUrl,
          'extract',
          {
            method: 'GET',
            headers: { 'User-Agent': REDDIT_USER_AGENT },
          },
          5000,
        );
        canonicalUrl = finalUrl;
      } catch {
        // Continue with original URL
      }
    }

    const canon = new URL(canonicalUrl);
    const cleanPath = canon.pathname.replace(/\/+$/, '');
    const target = parseRedditTarget(canonicalUrl, contentType);
    const isFeed =
      contentType === 'reddit_subreddit' || contentType === 'reddit_user';

    // Parse optional pagination cursor safely
    const redditAfterCursor = cursor?.startsWith('reddit:')
      ? cursor.slice(7).replace(/[^a-zA-Z0-9_]/g, '')
      : undefined;
    const arcticBeforeCursor = cursor?.startsWith('arctic:')
      ? Number(cursor.slice(7))
      : undefined;

    let posts: RedditPostData[] = [];
    let resolverUsed = 'Reddit Public JSON';
    let nextCursor: string | undefined;
    let hasMore = false;

    // Tier 1: Direct Reddit JSON (skip if cursor explicitly belongs to Arctic Shift)
    if (!arcticBeforeCursor) {
      let jsonEndpoint = '';
      const afterParam = redditAfterCursor
        ? `&after=${encodeURIComponent(redditAfterCursor)}`
        : '';

      if (target.kind === 'id') {
        jsonEndpoint = `https://www.reddit.com/comments/${encodeURIComponent(target.value)}.json?raw_json=1`;
      } else if (contentType === 'reddit_subreddit') {
        const hasSort = /\/(hot|new|top|rising)$/i.test(cleanPath);
        const sortSegment = hasSort ? '' : `/${subredditSort}`;
        const topParam =
          subredditSort === 'top' || cleanPath.endsWith('/top') ? '&t=month' : '';
        jsonEndpoint = `https://www.reddit.com${cleanPath}${sortSegment}.json?limit=${Math.min(safeLimit, 100)}&raw_json=1${topParam}${afterParam}`;
      } else if (contentType === 'reddit_user') {
        const userPath = /\/submitted$/i.test(cleanPath)
          ? cleanPath
          : `${cleanPath}/submitted`;
        const topParam = subredditSort === 'top' ? '&t=all' : '';
        jsonEndpoint = `https://www.reddit.com${userPath}.json?sort=${subredditSort}&limit=${Math.min(safeLimit, 100)}&raw_json=1${topParam}${afterParam}`;
      } else {
        jsonEndpoint = `https://www.reddit.com${cleanPath}.json?raw_json=1`;
      }

      const directPayload = await fetchDirectRedditJson(jsonEndpoint);
      if (Array.isArray(directPayload)) {
        const children = (
          directPayload[0] as {
            data?: { children?: Array<{ data?: RedditPostData }> };
          }
        )?.data?.children;
        const postData = children?.[0]?.data;
        if (postData) posts = [postData];
      } else if (directPayload && typeof directPayload === 'object') {
        const listingData = (
          directPayload as {
            data?: {
              after?: string | null;
              children?: Array<{ data?: RedditPostData }>;
            };
          }
        )?.data;
        if (Array.isArray(listingData?.children)) {
          posts = listingData.children
            .map((c) => c?.data)
            .filter((p): p is RedditPostData => Boolean(p));
          if (listingData.after) {
            nextCursor = `reddit:${listingData.after}`;
            hasMore = true;
          }
        }
      }
    }

    // Tier 2: Resilient Arctic Shift Public Index with multi-page walking & cursor pagination
    if (posts.length === 0 && target.kind !== 'unknown' && target.value) {
      resolverUsed = 'Reddit Public Index';

      if (target.kind === 'id') {
        posts = await fetchArcticShiftPage({ kind: 'id', id: target.value }, 1);
      } else {
        const maxWalkPages = safeLimit > 50 ? 3 : safeLimit > 25 ? 2 : 1;
        const batchSize = Math.min(Math.max(safeLimit * 2, 40), 100);
        let beforeUtc =
          arcticBeforeCursor && Number.isFinite(arcticBeforeCursor)
            ? arcticBeforeCursor
            : undefined;
        let lastPageReturnedCount = 0;

        for (let step = 0; step < maxWalkPages; step += 1) {
          if (step > 0) await sleep(250);
          const pagePosts = await fetchArcticShiftPage(
            target.kind === 'subreddit'
              ? { kind: 'subreddit', name: target.value }
              : { kind: 'user', name: target.value },
            batchSize,
            beforeUtc,
          );
          lastPageReturnedCount = pagePosts.length;
          if (pagePosts.length === 0) break;

          posts.push(...pagePosts);
          const oldestUtc = pagePosts.reduce<number | undefined>((min, p) => {
            if (typeof p.created_utc !== 'number') return min;
            return min === undefined ? p.created_utc : Math.min(min, p.created_utc);
          }, undefined);

          if (!oldestUtc || (beforeUtc !== undefined && oldestUtc >= beforeUtc)) {
            break;
          }
          beforeUtc = oldestUtc - 1;
          if (pagePosts.length < batchSize) break;
        }

        if (beforeUtc && lastPageReturnedCount >= Math.min(batchSize, 15)) {
          nextCursor = `arctic:${Math.floor(beforeUtc)}`;
          hasMore = true;
        }

        if (subredditSort === 'top' || subredditSort === 'hot') {
          posts = [...posts].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
        }
      }
    }

    const items: MediaItem[] = [];
    const seenPostIds = new Set<string>();
    let mediaPostCount = 0;

    for (const post of posts) {
      if (post.id && seenPostIds.has(post.id)) continue;
      if (post.id) seenPostIds.add(post.id);

      const extracted = await extractMediaFromPost(post, jobId, isFeed);
      if (extracted.length > 0) {
        items.push(...extracted);
        mediaPostCount += 1;
        if (isFeed && mediaPostCount >= safeLimit) break;
      }
    }

    if (items.length === 0) {
      return {
        job: {
          id: jobId,
          sourceUrl,
          platform: 'reddit',
          contentType,
          contentLabel:
            contentType === 'reddit_subreddit'
              ? 'Reddit Subreddit'
              : contentType === 'reddit_user'
                ? 'Reddit Public Profile'
                : 'Reddit Post',
          status: 'error',
          message: cursor
            ? 'No additional downloadable media found on the next page.'
            : 'No downloadable photo, gallery, or video assets were found in this Reddit link (it may be text-only or private).',
          itemCount: 0,
          resolverUsed,
          hasMore: false,
          pageNumber,
        },
        items: [],
      };
    }

    return {
      job: {
        id: jobId,
        sourceUrl,
        platform: 'reddit',
        contentType,
        contentLabel:
          contentType === 'reddit_subreddit'
            ? 'Reddit Subreddit'
            : contentType === 'reddit_user'
              ? 'Reddit Public Profile'
              : items.length > 1
                ? 'Reddit Gallery'
                : 'Reddit Post',
        status: 'ready',
        message: `Extracted ${items.length} media ${items.length === 1 ? 'file' : 'files'}.`,
        itemCount: items.length,
        resolverUsed,
        hasMore: isFeed ? hasMore : false,
        nextCursor: isFeed ? nextCursor : undefined,
        pageNumber,
      },
      items,
    };
  } catch (err) {
    return {
      job: {
        id: jobId,
        sourceUrl,
        platform: 'reddit',
        contentType,
        contentLabel: 'Reddit Link',
        status: 'error',
        message:
          err instanceof Error
            ? err.message
            : 'Failed to extract media from Reddit.',
        itemCount: 0,
        hasMore: false,
        pageNumber,
      },
      items: [],
    };
  }
}
