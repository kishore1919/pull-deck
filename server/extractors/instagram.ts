import crypto from 'node:crypto';
import type {
  ContentType,
  ExtractionJob,
  InstagramCategory,
  InstagramFetchScope,
  MediaItem,
} from '../../src/types.ts';
import { sanitizeFilename } from '../security.ts';
import { runInstaloaderWorker } from './instaloaderBridge.ts';

interface ParsedInstagramPath {
  shortcode?: string;
  username?: string;
  storyId?: string;
  highlightId?: string;
}

function parseInstagramPath(rawUrl: string): ParsedInstagramPath {
  const parsed = new URL(rawUrl);
  const path = parsed.pathname.replace(/\/+$/, '');

  const highlightMatch = path.match(/^\/stories\/highlights\/(\d+)/i);
  if (highlightMatch) {
    return { highlightId: highlightMatch[1] };
  }

  const storyMatch = path.match(/^\/stories\/([^/]+)(?:\/(\d+))?/i);
  if (storyMatch) {
    return { username: storyMatch[1], storyId: storyMatch[2] };
  }

  const postMatch = path.match(/(?:^\/[^/]+)?\/(?:p|reel|reels|tv)\/([^/?#]+)/i);
  if (postMatch) {
    return { shortcode: postMatch[1] };
  }

  const profileMatch = path.match(/^\/([a-zA-Z0-9._]{1,30})(?:\/(?:reels|tagged|videos))?$/i);
  if (profileMatch) {
    return { username: profileMatch[1] };
  }

  return {};
}

function makeIgItem(params: {
  jobId: string;
  contentType: ContentType;
  mediaType: 'image' | 'video';
  title: string;
  username: string;
  sourceUrl: string;
  mediaUrl: string;
  thumbnailUrl?: string;
  index: number;
  total: number;
  width?: number;
  height?: number;
  durationSec?: number;
  shortcodeOrId: string;
  createdAt?: string;
  igCategory?: InstagramCategory;
}): MediaItem {
  const ext = params.mediaType === 'video' ? 'mp4' : 'jpg';
  const cleanUser = params.username.replace(/^@/, '') || 'instagram';
  const suffix = params.total > 1 ? `_${String(params.index).padStart(2, '0')}` : '';

  const resolvedCategory: InstagramCategory =
    params.igCategory ||
    (params.contentType === 'ig_dp'
      ? 'dp'
      : params.contentType === 'ig_highlight'
        ? 'highlight'
        : params.contentType === 'ig_story'
          ? 'story'
          : params.contentType === 'ig_reel'
            ? 'reel'
            : params.mediaType === 'video'
              ? 'video'
              : 'photo');

  const itemContentType: ContentType =
    resolvedCategory === 'dp'
      ? 'ig_dp'
      : resolvedCategory === 'highlight'
        ? 'ig_highlight'
        : resolvedCategory === 'story'
          ? 'ig_story'
          : resolvedCategory === 'reel'
            ? 'ig_reel'
            : params.contentType;

  return {
    id: crypto.randomUUID(),
    jobId: params.jobId,
    platform: 'instagram',
    contentType: itemContentType,
    mediaType: params.mediaType,
    title: params.title || `Instagram ${params.shortcodeOrId}`,
    author: `@${cleanUser}`,
    sourceContainer: `@${cleanUser}`,
    sourceUrl: params.sourceUrl,
    mediaUrl: params.mediaUrl,
    thumbnailUrl: params.thumbnailUrl || params.mediaUrl,
    filename: sanitizeFilename(`${cleanUser}_${params.shortcodeOrId}${suffix}`, ext),
    extension: ext,
    width: params.width,
    height: params.height,
    durationSec: params.durationSec,
    indexInGroup: params.index,
    groupSize: params.total,
    createdAt: params.createdAt,
    igCategory: resolvedCategory,
  };
}

/**
 * Pure Python Instaloader Instagram coordinator (zero login, zero environment variables).
 * Delegates all public profile, post, carousel, and reel workloads—plus multi-layer
 * anonymous fallbacks—exclusively to the stateless Python Instaloader worker.
 */
export async function extractInstagramUrl(
  sourceUrl: string,
  contentType: ContentType,
  jobId: string,
  limit = 30,
  cursor?: string,
  pageNumber = 1,
  sessionId?: string,
  scope: InstagramFetchScope = 'all',
): Promise<{ job: ExtractionJob; items: MediaItem[] }> {
  const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const parsed = parseInstagramPath(sourceUrl);
  const labelMap: Record<ContentType, string> = {
    ig_profile: 'Instagram Profile',
    ig_post: 'Instagram Post',
    ig_reel: 'Instagram Reel',
    ig_dp: 'Instagram Profile Picture (DP)',
    ig_story: 'Instagram Story',
    ig_highlight: 'Instagram Highlight',
    reddit_post: 'Reddit Post',
    reddit_subreddit: 'Reddit Subreddit',
    reddit_user: 'Reddit Public Profile',
    redgifs_clip: 'RedGIFs Clip',
    redgifs_profile: 'RedGIFs Public Profile',
    unknown: 'Instagram Link',
  };
  const contentLabel = labelMap[contentType];

  if (
    ((contentType === 'ig_story' || contentType === 'ig_highlight') ||
      (contentType === 'ig_profile' && scope === 'story')) &&
    !sessionId
  ) {
    return {
      job: {
        id: jobId,
        sourceUrl,
        platform: 'instagram',
        contentType,
        contentLabel: scope === 'story' ? 'Instagram Stories' : contentLabel,
        status: 'auth_required',
        message:
          'Active 24-hour Stories require an Instagram session. Open Session unlock above to connect a temporary sessionid, or choose DP, Highlights, Reels, Videos, Photos, or All for zero-login downloads.',
        itemCount: 0,
        instagramScope: scope,
        hasMore: false,
        pageNumber,
      },
      items: [],
    };
  }

  let offset = 0;
  let workerCursor: string | undefined;

  if (cursor?.startsWith('ig_polaris:') || cursor?.startsWith('ig_frozen:')) {
    workerCursor = cursor;
  } else if (cursor?.startsWith('ig_loader:')) {
    const rawOffset = Number(cursor.slice(10));
    if (Number.isInteger(rawOffset) && rawOffset >= 0 && rawOffset <= 5000) {
      offset = rawOffset;
    }
  }

  const workerResult = await runInstaloaderWorker({
    contentType,
    sourceUrl,
    username: parsed.username,
    shortcode: parsed.shortcode,
    storyId: parsed.storyId,
    highlightId: parsed.highlightId,
    limit: safeLimit,
    offset,
    cursor: workerCursor,
    sessionId,
    scope,
  });

  if (workerResult.ok && workerResult.items && workerResult.items.length > 0) {
    const items: MediaItem[] = workerResult.items.map((entry) =>
      makeIgItem({
        jobId,
        contentType,
        mediaType: entry.mediaType,
        title: entry.title,
        username: entry.username,
        sourceUrl: entry.sourceUrl || sourceUrl,
        mediaUrl: entry.mediaUrl,
        thumbnailUrl: entry.thumbnailUrl,
        index: entry.index || 1,
        total: entry.total || 1,
        width: typeof entry.width === 'number' ? entry.width : undefined,
        height: typeof entry.height === 'number' ? entry.height : undefined,
        durationSec:
          typeof entry.durationSec === 'number' ? entry.durationSec : undefined,
        shortcodeOrId: entry.shortcodeOrId || parsed.shortcode || parsed.username || 'ig',
        createdAt: entry.createdAt || undefined,
        igCategory: entry.igCategory || undefined,
      }),
    );

    const nextCursor =
      workerResult.hasMore && workerResult.nextCursor
        ? workerResult.nextCursor
        : workerResult.hasMore && typeof workerResult.nextOffset === 'number'
          ? `ig_loader:${workerResult.nextOffset}`
          : undefined;

    const isPrivateProfile = Boolean(workerResult.private);

    const resolvedLabel = isPrivateProfile
      ? 'Private Profile · HD DP'
      : contentLabel;

    const partialSuffix = workerResult.partial
      ? ' (paused early due to Instagram rate limit)'
      : '';

    return {
      job: {
        id: jobId,
        sourceUrl,
        platform: 'instagram',
        contentType,
        contentLabel: resolvedLabel,
        status: 'ready',
        message:
          workerResult.notice ||
          `Extracted ${items.length} media ${items.length === 1 ? 'file' : 'files'} via Instaloader${partialSuffix}.`,
        itemCount: items.length,
        totalAvailable:
          typeof workerResult.totalAvailable === 'number'
            ? workerResult.totalAvailable
            : undefined,
        resolverUsed: sessionId ? 'Python Instaloader (Session)' : 'Python Instaloader',
        isPrivateProfile,
        instagramScope: scope,
        hasMore: Boolean(workerResult.hasMore && nextCursor),
        nextCursor,
        pageNumber,
      },
      items,
    };
  }

  return {
    job: {
      id: jobId,
      sourceUrl,
      platform: 'instagram',
      contentType,
      contentLabel,
      status: workerResult.sessionInvalid ? 'auth_required' : 'error',
      message:
        workerResult.error ||
        `Could not fetch media from ${parsed.username ? `@${parsed.username}` : 'this Instagram link'} via Instaloader.`,
      itemCount: 0,
      instagramScope: scope,
      hasMore: false,
      pageNumber,
    },
    items: [],
  };
}
