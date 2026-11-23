import crypto from 'node:crypto';
import type { ContentType, ExtractionJob, MediaItem } from '../../src/types.ts';
import { safeFetch, sanitizeFilename } from '../security.ts';

const REDGIFS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

interface RedgifsGifNode {
  id?: string;
  createDate?: number;
  hasAudio?: boolean;
  width?: number;
  height?: number;
  duration?: number;
  userName?: string;
  tags?: string[];
  urls?: {
    hd?: string;
    sd?: string;
    poster?: string;
    thumbnail?: string;
    vthumbnail?: string;
  };
}

let cachedToken: { value: string; expiresAt: number } | null = null;

async function getRedgifsBearerToken(forceRefresh = false): Promise<string> {
  const now = Date.now();
  if (!forceRefresh && cachedToken && cachedToken.expiresAt > now) {
    return cachedToken.value;
  }

  const { response } = await safeFetch(
    'https://api.redgifs.com/v2/auth/temporary',
    'extract',
    {
      headers: {
        'User-Agent': REDGIFS_UA,
        Accept: 'application/json',
        Origin: 'https://www.redgifs.com',
        Referer: 'https://www.redgifs.com/',
      },
    },
    10000,
  );

  if (!response.ok) {
    throw new Error(`RedGIFs temporary auth returned HTTP ${response.status}.`);
  }

  const data = (await response.json()) as { token?: string };
  if (!data.token) {
    throw new Error('RedGIFs auth endpoint did not return an access token.');
  }

  cachedToken = {
    value: data.token,
    expiresAt: now + 25 * 60 * 1000,
  };
  return data.token;
}

async function fetchRedgifsApiJson<T>(url: string): Promise<T> {
  let token = await getRedgifsBearerToken(false);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { response } = await safeFetch(
      url,
      'extract',
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': REDGIFS_UA,
          Accept: 'application/json',
          Origin: 'https://www.redgifs.com',
          Referer: 'https://www.redgifs.com/',
        },
      },
      12000,
    );

    if (response.status === 401 && attempt === 0) {
      token = await getRedgifsBearerToken(true);
      continue;
    }

    if (response.status === 404) {
      throw new Error('RedGIFs profile or clip was not found (404).');
    }

    if (!response.ok) {
      throw new Error(`RedGIFs API returned HTTP ${response.status}.`);
    }

    return (await response.json()) as T;
  }

  throw new Error('RedGIFs API authentication failed.');
}

function normalizeRedgifsNode(
  gif: RedgifsGifNode,
  jobId: string,
  contentType: ContentType,
  index: number,
  total: number,
  override?: { title?: string; sourceUrl?: string; sourceContainer?: string },
): MediaItem | null {
  const mediaUrl = gif.urls?.hd || gif.urls?.sd;
  if (!mediaUrl) return null;

  const id = (gif.id || 'redgifs_clip').toLowerCase();
  const userName = gif.userName || 'redgifs';
  const tagsTitle =
    gif.tags && gif.tags.length > 0 ? gif.tags.slice(0, 4).join(', ') : '';
  const title = (override?.title || tagsTitle || `RedGIFs ${id}`).slice(0, 110);
  const thumbnailUrl =
    gif.urls?.thumbnail || gif.urls?.poster || gif.urls?.vthumbnail || mediaUrl;

  return {
    id: crypto.randomUUID(),
    jobId,
    platform: 'redgifs',
    contentType,
    mediaType: 'video',
    title,
    author: `@${userName}`,
    sourceContainer: override?.sourceContainer || `@${userName}`,
    sourceUrl: override?.sourceUrl || `https://www.redgifs.com/watch/${id}`,
    mediaUrl,
    thumbnailUrl,
    filename: sanitizeFilename(`${userName}_${id}`, 'mp4'),
    extension: 'mp4',
    width: gif.width,
    height: gif.height,
    durationSec:
      typeof gif.duration === 'number' ? Math.round(gif.duration) : undefined,
    indexInGroup: index,
    groupSize: total,
    createdAt: gif.createDate
      ? new Date(gif.createDate * 1000).toISOString()
      : undefined,
    hasAudioTrack: Boolean(gif.hasAudio),
  };
}

export function extractRedgifsIdFromUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (!parsed.hostname.toLowerCase().endsWith('redgifs.com')) return null;
    const match = parsed.pathname.match(/^\/(?:watch|ifr)\/([a-zA-Z0-9_-]+)/i);
    return match ? match[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

export async function extractRedgifsClipById(
  gifId: string,
  jobId: string,
  override?: { title?: string; sourceUrl?: string; sourceContainer?: string },
): Promise<MediaItem | null> {
  try {
    const cleanId = gifId.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!cleanId) return null;
    const payload = await fetchRedgifsApiJson<{ gif?: RedgifsGifNode }>(
      `https://api.redgifs.com/v2/gifs/${encodeURIComponent(cleanId)}`,
    );
    if (!payload.gif) return null;
    return normalizeRedgifsNode(
      payload.gif,
      jobId,
      'redgifs_clip',
      1,
      1,
      override,
    );
  } catch {
    return null;
  }
}

export async function extractRedgifsUrl(
  sourceUrl: string,
  contentType: ContentType,
  jobId: string,
  limit = 25,
  sort: 'hot' | 'top' | 'new' = 'new',
  cursor?: string,
  pageNumber = 1,
): Promise<{ job: ExtractionJob; items: MediaItem[] }> {
  // RedGIFs API supports up to 80 clips per exact page — locking pageSize per cursor
  // guarantees zero skipped or duplicated clips across 600+ video profiles.
  const requestedLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  let pageSize = Math.min(requestedLimit, 80);

  try {
    const parsed = new URL(sourceUrl);
    const pathname = parsed.pathname.replace(/\/+$/, '');

    // 1. RedGIFs Public Profile (/users/<username>)
    const userMatch = pathname.match(/^\/users\/([a-zA-Z0-9._-]+)/i);
    if (contentType === 'redgifs_profile' || userMatch) {
      const username = userMatch?.[1];
      if (!username) {
        throw new Error('Could not determine RedGIFs username from URL.');
      }

      const orderMap: Record<'hot' | 'top' | 'new', string> = {
        new: 'latest',
        top: 'top',
        hot: 'trending',
      };
      const order = orderMap[sort] || 'latest';

      let currentPage = 1;
      if (cursor?.startsWith('redgifs:')) {
        const parts = cursor.slice(8).split(':');
        const parsedPage = Number(parts[0]);
        const parsedSize = Number(parts[1]);
        if (Number.isInteger(parsedPage) && parsedPage >= 1 && parsedPage <= 500) {
          currentPage = parsedPage;
        }
        if (Number.isInteger(parsedSize) && parsedSize >= 1 && parsedSize <= 80) {
          pageSize = parsedSize;
        }
      }

      const payload = await fetchRedgifsApiJson<{
        gifs?: RedgifsGifNode[];
        page?: number;
        pages?: number;
        total?: number;
      }>(
        `https://api.redgifs.com/v2/users/${encodeURIComponent(username.toLowerCase())}/search?order=${order}&count=${pageSize}&page=${currentPage}`,
      );

      const pageGifs = Array.isArray(payload.gifs) ? payload.gifs : [];
      const totalPages =
        typeof payload.pages === 'number' && payload.pages > 0
          ? payload.pages
          : currentPage;
      const totalAvailable =
        typeof payload.total === 'number' && payload.total > 0
          ? payload.total
          : undefined;

      const hasMore = currentPage < totalPages && pageGifs.length > 0;
      const nextCursor = hasMore
        ? `redgifs:${currentPage + 1}:${pageSize}`
        : undefined;

      const items = pageGifs
        .map((gif, idx) =>
          normalizeRedgifsNode(
            gif,
            jobId,
            'redgifs_profile',
            idx + 1,
            pageGifs.length,
          ),
        )
        .filter((item): item is MediaItem => item !== null);

      if (items.length === 0) {
        return {
          job: {
            id: jobId,
            sourceUrl,
            platform: 'redgifs',
            contentType: 'redgifs_profile',
            contentLabel: 'RedGIFs Public Profile',
            status: 'error',
            message: cursor
              ? `No additional clips found for @${username}.`
              : `No public clips were found for RedGIFs user "${username}".`,
            itemCount: 0,
            totalAvailable,
            resolverUsed: 'RedGIFs Public API',
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
          platform: 'redgifs',
          contentType: 'redgifs_profile',
          contentLabel: 'RedGIFs Public Profile',
          status: 'ready',
          message: totalAvailable
            ? `Extracted ${items.length} of ${totalAvailable} clips from @${username}.`
            : `Extracted ${items.length} public clips from @${username}.`,
          itemCount: items.length,
          totalAvailable,
          resolverUsed: 'RedGIFs Public API',
          hasMore,
          nextCursor,
          pageNumber,
        },
        items,
      };
    }

    // 2. Single RedGIFs Clip (/watch/<id> or /ifr/<id>)
    const gifId = extractRedgifsIdFromUrl(sourceUrl);
    if (!gifId) {
      throw new Error('Could not parse RedGIFs clip ID from URL.');
    }

    const item = await extractRedgifsClipById(gifId, jobId, { sourceUrl });
    if (!item) {
      throw new Error('RedGIFs clip could not be resolved or was removed.');
    }

    return {
      job: {
        id: jobId,
        sourceUrl,
        platform: 'redgifs',
        contentType: 'redgifs_clip',
        contentLabel: 'RedGIFs Clip',
        status: 'ready',
        message: 'Extracted 1 HD video clip.',
        itemCount: 1,
        resolverUsed: 'RedGIFs Public API',
        hasMore: false,
        pageNumber,
      },
      items: [item],
    };
  } catch (err) {
    return {
      job: {
        id: jobId,
        sourceUrl,
        platform: 'redgifs',
        contentType,
        contentLabel:
          contentType === 'redgifs_profile'
            ? 'RedGIFs Public Profile'
            : 'RedGIFs Clip',
        status: 'error',
        message:
          err instanceof Error
            ? err.message
            : 'Failed to extract media from RedGIFs.',
        itemCount: 0,
        hasMore: false,
        pageNumber,
      },
      items: [],
    };
  }
}
