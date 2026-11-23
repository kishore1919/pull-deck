import crypto from 'node:crypto';
import * as cheerio from 'cheerio';
import type { ContentType, ExtractionJob, MediaItem } from '../../src/types.ts';
import { safeFetch, sanitizeFilename } from '../security.ts';
import { runInstaloaderWorker } from './instaloaderBridge.ts';

const IG_WEB_APP_ID = '936619743392459';
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

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

  const profileMatch = path.match(/^\/([a-zA-Z0-9._]{1,30})(?:\/(?:reels|tagged))?$/i);
  if (profileMatch) {
    return { username: profileMatch[1] };
  }

  return {};
}

function decodeEscapedUrl(raw: string): string {
  return raw
    .replace(/\\u0026/g, '&')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&');
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
}): MediaItem {
  const ext = params.mediaType === 'video' ? 'mp4' : 'jpg';
  const cleanUser = params.username.replace(/^@/, '') || 'instagram';
  const suffix = params.total > 1 ? `_${String(params.index).padStart(2, '0')}` : '';

  return {
    id: crypto.randomUUID(),
    jobId: params.jobId,
    platform: 'instagram',
    contentType: params.contentType,
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
  };
}

function normalizeIgApiMediaList(
  rawNodes: Array<Record<string, unknown>>,
  jobId: string,
  contentType: ContentType,
  sourceUrl: string,
  fallbackUser: string,
  shortcodeOrId: string,
): MediaItem[] {
  const collected: Array<{
    mediaType: 'image' | 'video';
    mediaUrl: string;
    thumbnailUrl: string;
    width?: number;
    height?: number;
    durationSec?: number;
    username: string;
    title: string;
  }> = [];

  for (const node of rawNodes) {
    const userObj = node.user as { username?: string } | undefined;
    const ownerObj = node.owner as { username?: string } | undefined;
    const username = userObj?.username || ownerObj?.username || fallbackUser;

    const captionObj = node.caption as { text?: string } | undefined;
    const edgeCaption = (
      node.edge_media_to_caption as {
        edges?: Array<{ node?: { text?: string } }>;
      } | undefined
    )?.edges?.[0]?.node?.text;
    const title = (captionObj?.text || edgeCaption || '').slice(0, 110);

    // Carousel children (API v1)
    const carousel = node.carousel_media as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(carousel) && carousel.length > 0) {
      for (const slide of carousel) {
        const videoVersions = slide.video_versions as Array<{
          url?: string;
          width?: number;
          height?: number;
        }> | undefined;
        const imgCandidates = (
          slide.image_versions2 as {
            candidates?: Array<{ url?: string; width?: number; height?: number }>;
          } | undefined
        )?.candidates;

        if (videoVersions?.[0]?.url) {
          collected.push({
            mediaType: 'video',
            mediaUrl: videoVersions[0].url,
            thumbnailUrl: imgCandidates?.[0]?.url || videoVersions[0].url,
            width: videoVersions[0].width,
            height: videoVersions[0].height,
            username,
            title,
          });
        } else if (imgCandidates?.[0]?.url) {
          collected.push({
            mediaType: 'image',
            mediaUrl: imgCandidates[0].url,
            thumbnailUrl: imgCandidates[0].url,
            width: imgCandidates[0].width,
            height: imgCandidates[0].height,
            username,
            title,
          });
        }
      }
      continue;
    }

    // GraphQL sidecar children
    const sidecar = (
      node.edge_sidecar_to_children as {
        edges?: Array<{ node?: Record<string, unknown> }>;
      } | undefined
    )?.edges;
    if (Array.isArray(sidecar) && sidecar.length > 0) {
      for (const edge of sidecar) {
        const child = edge.node;
        if (!child) continue;
        const isVideo = Boolean(child.is_video && child.video_url);
        const dims = child.dimensions as { width?: number; height?: number } | undefined;
        if (isVideo) {
          collected.push({
            mediaType: 'video',
            mediaUrl: String(child.video_url),
            thumbnailUrl: String(child.display_url || child.video_url),
            width: dims?.width,
            height: dims?.height,
            username,
            title,
          });
        } else if (child.display_url) {
          collected.push({
            mediaType: 'image',
            mediaUrl: String(child.display_url),
            thumbnailUrl: String(child.display_url),
            width: dims?.width,
            height: dims?.height,
            username,
            title,
          });
        }
      }
      continue;
    }

    // Single item (API v1 or GraphQL)
    const videoVersions = node.video_versions as Array<{
      url?: string;
      width?: number;
      height?: number;
    }> | undefined;
    const imgCandidates = (
      node.image_versions2 as {
        candidates?: Array<{ url?: string; width?: number; height?: number }>;
      } | undefined
    )?.candidates;
    const dims = node.dimensions as { width?: number; height?: number } | undefined;

    if (videoVersions?.[0]?.url) {
      collected.push({
        mediaType: 'video',
        mediaUrl: videoVersions[0].url,
        thumbnailUrl: imgCandidates?.[0]?.url || videoVersions[0].url,
        width: videoVersions[0].width,
        height: videoVersions[0].height,
        durationSec:
          typeof node.video_duration === 'number'
            ? Math.round(node.video_duration)
            : undefined,
        username,
        title,
      });
    } else if (node.video_url) {
      collected.push({
        mediaType: 'video',
        mediaUrl: String(node.video_url),
        thumbnailUrl: String(node.display_url || node.video_url),
        width: dims?.width,
        height: dims?.height,
        username,
        title,
      });
    } else if (imgCandidates?.[0]?.url) {
      collected.push({
        mediaType: 'image',
        mediaUrl: imgCandidates[0].url,
        thumbnailUrl: imgCandidates[0].url,
        width: imgCandidates[0].width,
        height: imgCandidates[0].height,
        username,
        title,
      });
    } else if (node.display_url) {
      collected.push({
        mediaType: 'image',
        mediaUrl: String(node.display_url),
        thumbnailUrl: String(node.display_url),
        width: dims?.width,
        height: dims?.height,
        username,
        title,
      });
    }
  }

  return collected.map((entry, idx) =>
    makeIgItem({
      jobId,
      contentType,
      mediaType: entry.mediaType,
      title: entry.title,
      username: entry.username,
      sourceUrl,
      mediaUrl: entry.mediaUrl,
      thumbnailUrl: entry.thumbnailUrl,
      index: idx + 1,
      total: collected.length,
      width: entry.width,
      height: entry.height,
      durationSec: entry.durationSec,
      shortcodeOrId,
    }),
  );
}

interface IgPageResult {
  items: MediaItem[];
  nextCursor?: string;
  hasMore?: boolean;
  totalAvailable?: number;
}

/**
 * Tier 1B: Python Instaloader Worker (handles Profiles, Posts, Reels, Stories & Highlights)
 */
async function tryInstaloaderExtraction(
  sourceUrl: string,
  contentType: ContentType,
  parsed: ParsedInstagramPath,
  jobId: string,
  limit: number,
  cursor?: string,
): Promise<(IgPageResult & { authRequired?: boolean; error?: string }) | null> {
  let offset = 0;
  let frozenCursor: string | undefined;

  if (cursor?.startsWith('ig_frozen:')) {
    frozenCursor = cursor.slice(10);
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
    limit,
    offset,
    frozenCursor,
  });

  if (!workerResult) return null;

  if (!workerResult.ok || !workerResult.items || workerResult.items.length === 0) {
    return {
      items: [],
      hasMore: false,
      authRequired: workerResult.authRequired,
      error: workerResult.error,
    };
  }

  const mapped: MediaItem[] = workerResult.items.map((entry) => {
    const item = makeIgItem({
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
    });
    if (entry.createdAt) {
      item.createdAt = entry.createdAt;
    }
    return item;
  });

  const nextCursor =
    workerResult.hasMore && workerResult.nextFrozenCursor
      ? `ig_frozen:${workerResult.nextFrozenCursor}`
      : workerResult.hasMore && typeof workerResult.nextOffset === 'number'
        ? `ig_loader:${workerResult.nextOffset}`
        : undefined;

  return {
    items: mapped,
    hasMore: Boolean(workerResult.hasMore && nextCursor),
    nextCursor,
    totalAvailable:
      typeof workerResult.totalAvailable === 'number'
        ? workerResult.totalAvailable
        : undefined,
  };
}

/**
 * Tier 1A: Server-side RapidAPI connector (if configured in environment)
 */
async function tryRapidApiExtraction(
  sourceUrl: string,
  contentType: ContentType,
  parsed: ParsedInstagramPath,
  jobId: string,
  limit: number,
  cursor?: string,
): Promise<IgPageResult | null> {
  const apiKey = process.env.INSTAGRAM_RAPIDAPI_KEY?.trim();
  const apiHost = process.env.INSTAGRAM_RAPIDAPI_HOST?.trim();
  if (!apiKey || !apiHost) return null;

  const rapidToken = cursor?.startsWith('ig_rapid:') ? cursor.slice(9) : undefined;

  let endpoint = '';
  if (contentType === 'ig_profile' && parsed.username) {
    const tokenParam = rapidToken
      ? `&pagination_token=${encodeURIComponent(rapidToken)}`
      : '';
    endpoint = `https://${apiHost}/v1/posts?username_or_id_or_url=${encodeURIComponent(parsed.username)}${tokenParam}`;
  } else if (contentType === 'ig_story' && parsed.username) {
    endpoint = `https://${apiHost}/v1/stories?username_or_id_or_url=${encodeURIComponent(parsed.username)}`;
  } else if (contentType === 'ig_highlight' && parsed.highlightId) {
    endpoint = `https://${apiHost}/v1/highlight_info?highlight_id=${encodeURIComponent(parsed.highlightId)}`;
  } else {
    endpoint = `https://${apiHost}/v1/post_info?code_or_id_or_url=${encodeURIComponent(sourceUrl)}`;
  }

  try {
    const { response } = await safeFetch(endpoint, 'rapidapi', {
      headers: {
        'x-rapidapi-key': apiKey,
        'x-rapidapi-host': apiHost,
        Accept: 'application/json',
      },
    });
    if (!response.ok) return null;
    const json = (await response.json()) as {
      pagination_token?: string;
      data?: Record<string, unknown> & { items?: Array<Record<string, unknown>> };
    };
    const rawNodes = Array.isArray(json.data?.items)
      ? json.data!.items.slice(0, limit)
      : json.data
        ? [json.data]
        : [];
    const items = normalizeIgApiMediaList(
      rawNodes,
      jobId,
      contentType,
      sourceUrl,
      parsed.username || 'instagram',
      parsed.shortcode || parsed.highlightId || parsed.storyId || parsed.username || 'ig',
    );
    if (items.length === 0) return null;
    return {
      items,
      hasMore: Boolean(json.pagination_token),
      nextCursor: json.pagination_token
        ? `ig_rapid:${json.pagination_token}`
        : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Shared web_profile_info & paginated user feed extractor
 */
async function tryWebProfileInfo(
  username: string,
  sourceUrl: string,
  jobId: string,
  limit: number,
  sessionId?: string,
  cursor?: string,
): Promise<IgPageResult | null> {
  const headers: Record<string, string> = {
    'User-Agent': BROWSER_UA,
    'x-ig-app-id': IG_WEB_APP_ID,
    Accept: 'application/json',
    Referer: `https://www.instagram.com/${encodeURIComponent(username)}/`,
  };
  if (sessionId) {
    headers.Cookie = `sessionid=${sessionId};`;
  }

  try {
    // Paginated continuation via session feed API (ig_session:<userId>:<maxId>)
    if (sessionId && cursor?.startsWith('ig_session:')) {
      const parts = cursor.slice(11).split(':');
      const userId = parts[0]?.replace(/[^0-9]/g, '');
      const maxId = parts.slice(1).join(':');
      if (userId && maxId) {
        const feedRes = await safeFetch(
          `https://www.instagram.com/api/v1/feed/user/${encodeURIComponent(userId)}/?count=${Math.min(limit, 33)}&max_id=${encodeURIComponent(maxId)}`,
          'extract',
          { headers },
        );
        if (!feedRes.response.ok) return null;
        const feedJson = (await feedRes.response.json()) as {
          items?: Array<Record<string, unknown>>;
          more_available?: boolean;
          next_max_id?: string;
        };
        const nodes = Array.isArray(feedJson.items)
          ? feedJson.items.slice(0, limit)
          : [];
        const items = normalizeIgApiMediaList(
          nodes,
          jobId,
          'ig_profile',
          sourceUrl,
          username,
          username,
        );
        if (items.length === 0) return null;
        return {
          items,
          hasMore: Boolean(feedJson.more_available && feedJson.next_max_id),
          nextCursor:
            feedJson.more_available && feedJson.next_max_id
              ? `ig_session:${userId}:${feedJson.next_max_id}`
              : undefined,
        };
      }
    }

    const { response } = await safeFetch(
      `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
      'extract',
      { headers },
    );
    if (!response.ok) return null;
    const json = (await response.json()) as {
      data?: {
        user?: {
          id?: string;
          username?: string;
          edge_owner_to_timeline_media?: {
            page_info?: { has_next_page?: boolean; end_cursor?: string };
            edges?: Array<{ node?: Record<string, unknown> }>;
          };
        };
      };
    };

    const user = json.data?.user;
    if (!user) return null;

    const timeline = user.edge_owner_to_timeline_media;
    const timelineEdges = timeline?.edges || [];
    const nodes = timelineEdges
      .map((edge) => edge.node)
      .filter((n): n is Record<string, unknown> => Boolean(n))
      .slice(0, limit);

    if (nodes.length === 0) return null;

    const items = normalizeIgApiMediaList(
      nodes,
      jobId,
      'ig_profile',
      sourceUrl,
      user.username || username,
      user.username || username,
    );

    const lastNodeId = nodes[nodes.length - 1]?.id;
    const canPaginate = Boolean(
      sessionId &&
        user.id &&
        timeline?.page_info?.has_next_page &&
        lastNodeId,
    );

    return {
      items,
      hasMore: canPaginate,
      nextCursor: canPaginate
        ? `ig_session:${user.id}:${String(lastNodeId)}`
        : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Tier 1B: Server-side Instagram session cookie connector (if configured in environment)
 */
async function trySessionCookieExtraction(
  sourceUrl: string,
  contentType: ContentType,
  parsed: ParsedInstagramPath,
  jobId: string,
  limit: number,
  cursor?: string,
): Promise<IgPageResult | null> {
  const sessionId = process.env.INSTAGRAM_SESSION_ID?.trim();
  if (!sessionId) return null;

  const headers: Record<string, string> = {
    'User-Agent': BROWSER_UA,
    'x-ig-app-id': IG_WEB_APP_ID,
    Cookie: `sessionid=${sessionId};`,
    Accept: 'application/json',
  };

  try {
    if (contentType === 'ig_profile' && parsed.username) {
      return await tryWebProfileInfo(
        parsed.username,
        sourceUrl,
        jobId,
        limit,
        sessionId,
        cursor,
      );
    }

    if (contentType === 'ig_story' && parsed.username) {
      const profileRes = await safeFetch(
        `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(parsed.username)}`,
        'extract',
        { headers },
      );
      if (!profileRes.response.ok) return null;
      const profileJson = (await profileRes.response.json()) as {
        data?: { user?: { id?: string } };
      };
      const userId = profileJson.data?.user?.id;
      if (!userId) return null;

      const reelRes = await safeFetch(
        `https://www.instagram.com/api/v1/feed/reels_media/?reel_ids=${encodeURIComponent(userId)}`,
        'extract',
        { headers },
      );
      if (!reelRes.response.ok) return null;
      const reelJson = (await reelRes.response.json()) as {
        reels?: Record<string, { items?: Array<Record<string, unknown>> }>;
        reels_media?: Array<{ items?: Array<Record<string, unknown>> }>;
      };
      const rawItems =
        reelJson.reels?.[userId]?.items || reelJson.reels_media?.[0]?.items || [];
      const filtered = parsed.storyId
        ? rawItems.filter((item) => String(item.pk || item.id).startsWith(parsed.storyId!))
        : rawItems;
      const chosen = filtered.length > 0 ? filtered : rawItems;
      const items = normalizeIgApiMediaList(
        chosen,
        jobId,
        contentType,
        sourceUrl,
        parsed.username,
        parsed.storyId || 'story',
      );
      return items.length > 0 ? { items, hasMore: false } : null;
    }

    if (contentType === 'ig_highlight' && parsed.highlightId) {
      const reelId = `highlight:${parsed.highlightId}`;
      const reelRes = await safeFetch(
        `https://www.instagram.com/api/v1/feed/reels_media/?reel_ids=${encodeURIComponent(reelId)}`,
        'extract',
        { headers },
      );
      if (!reelRes.response.ok) return null;
      const reelJson = (await reelRes.response.json()) as {
        reels?: Record<string, { items?: Array<Record<string, unknown>> }>;
        reels_media?: Array<{ items?: Array<Record<string, unknown>> }>;
      };
      const rawItems =
        reelJson.reels?.[reelId]?.items || reelJson.reels_media?.[0]?.items || [];
      const items = normalizeIgApiMediaList(
        rawItems,
        jobId,
        contentType,
        sourceUrl,
        'highlight',
        parsed.highlightId,
      );
      return items.length > 0 ? { items, hasMore: false } : null;
    }

    if (parsed.shortcode) {
      const postRes = await safeFetch(
        `https://www.instagram.com/p/${encodeURIComponent(parsed.shortcode)}/?__a=1&__d=dis`,
        'extract',
        { headers },
      );
      if (!postRes.response.ok) return null;
      const json = (await postRes.response.json()) as {
        items?: Array<Record<string, unknown>>;
        graphql?: { shortcode_media?: Record<string, unknown> };
      };
      const nodes = Array.isArray(json.items)
        ? json.items
        : json.graphql?.shortcode_media
          ? [json.graphql.shortcode_media]
          : [];
      const items = normalizeIgApiMediaList(
        nodes,
        jobId,
        contentType,
        sourceUrl,
        'instagram',
        parsed.shortcode,
      );
      return items.length > 0 ? { items, hasMore: false } : null;
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Tier 2: Public Embed & Metadata Extractor for Public Posts and Reels (No credentials needed)
 */
async function tryPublicPostExtraction(
  sourceUrl: string,
  contentType: ContentType,
  shortcode: string,
  jobId: string,
): Promise<MediaItem[] | null> {
  const embedUrl = `https://www.instagram.com/p/${encodeURIComponent(shortcode)}/embed/captioned/`;
  try {
    const { response } = await safeFetch(embedUrl, 'extract', {
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (response.ok) {
      const html = await response.text();
      const $ = cheerio.load(html);
      const username =
        $('.UsernameText').first().text().trim() ||
        $('.HeaderText .Username').first().text().trim() ||
        'instagram';
      const caption =
        $('.Caption').first().clone().children('.CaptionUsername').remove().end().text().trim() ||
        `Instagram ${contentType === 'ig_reel' ? 'Reel' : 'Post'} (${shortcode})`;

      const gqlMatch = html.match(/"gql_data"\s*:\s*(\{[\s\S]*?\})\s*,\s*"/);
      if (gqlMatch) {
        try {
          const parsedGql = JSON.parse(gqlMatch[1]) as {
            shortcode_media?: Record<string, unknown>;
          };
          if (parsedGql.shortcode_media) {
            const items = normalizeIgApiMediaList(
              [parsedGql.shortcode_media],
              jobId,
              contentType,
              sourceUrl,
              username,
              shortcode,
            );
            if (items.length > 0) return items;
          }
        } catch {
          // fall through
        }
      }

      const videoMatch = html.match(/"video_url"\s*:\s*"([^"]+)"/);
      const displayMatch = html.match(/"display_url"\s*:\s*"([^"]+)"/);

      if (videoMatch?.[1]) {
        const videoUrl = decodeEscapedUrl(videoMatch[1]);
        const thumbUrl = displayMatch?.[1]
          ? decodeEscapedUrl(displayMatch[1])
          : $('.EmbeddedMediaImage').first().attr('src') || videoUrl;
        return [
          makeIgItem({
            jobId,
            contentType,
            mediaType: 'video',
            title: caption.slice(0, 110),
            username,
            sourceUrl,
            mediaUrl: videoUrl,
            thumbnailUrl: thumbUrl,
            index: 1,
            total: 1,
            shortcodeOrId: shortcode,
          }),
        ];
      }

      const imgSrc =
        $('.EmbeddedMediaImage').first().attr('src') ||
        (displayMatch?.[1] ? decodeEscapedUrl(displayMatch[1]) : '');
      if (imgSrc && /^https?:\/\//i.test(imgSrc)) {
        return [
          makeIgItem({
            jobId,
            contentType,
            mediaType: 'image',
            title: caption.slice(0, 110),
            username,
            sourceUrl,
            mediaUrl: imgSrc,
            thumbnailUrl: imgSrc,
            index: 1,
            total: 1,
            shortcodeOrId: shortcode,
          }),
        ];
      }
    }
  } catch {
    // Try OpenGraph fallback below
  }

  try {
    const { response } = await safeFetch(sourceUrl, 'extract', {
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!response.ok) return null;
    const html = await response.text();
    const $ = cheerio.load(html);
    const ogVideo = $('meta[property="og:video"]').attr('content');
    const ogImage = $('meta[property="og:image"]').attr('content');
    const ogTitle =
      $('meta[property="og:title"]').attr('content') ||
      `Instagram Post (${shortcode})`;
    const userFromTitle = ogTitle.match(/@([a-zA-Z0-9._]+)/)?.[1] || 'instagram';

    if (ogVideo && /^https?:\/\//i.test(ogVideo)) {
      return [
        makeIgItem({
          jobId,
          contentType,
          mediaType: 'video',
          title: ogTitle.slice(0, 110),
          username: userFromTitle,
          sourceUrl,
          mediaUrl: ogVideo,
          thumbnailUrl: ogImage || ogVideo,
          index: 1,
          total: 1,
          shortcodeOrId: shortcode,
        }),
      ];
    }
    if (ogImage && /^https?:\/\//i.test(ogImage) && !ogImage.includes('static.cdninstagram.com/rsrc')) {
      return [
        makeIgItem({
          jobId,
          contentType,
          mediaType: 'image',
          title: ogTitle.slice(0, 110),
          username: userFromTitle,
          sourceUrl,
          mediaUrl: ogImage,
          thumbnailUrl: ogImage,
          index: 1,
          total: 1,
          shortcodeOrId: shortcode,
        }),
      ];
    }
  } catch {
    return null;
  }

  return null;
}

export async function extractInstagramUrl(
  sourceUrl: string,
  contentType: ContentType,
  jobId: string,
  limit = 25,
  cursor?: string,
  pageNumber = 1,
): Promise<{ job: ExtractionJob; items: MediaItem[] }> {
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const parsed = parseInstagramPath(sourceUrl);
  const labelMap: Record<ContentType, string> = {
    ig_profile: 'Instagram Public Profile',
    ig_post: 'Instagram Post',
    ig_reel: 'Instagram Reel',
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
  const hasServerAuth = Boolean(
    process.env.INSTAGRAM_SESSION_ID?.trim() ||
      (process.env.INSTAGRAM_RAPIDAPI_KEY?.trim() &&
        process.env.INSTAGRAM_RAPIDAPI_HOST?.trim()),
  );

  // Direct pagination route for Instaloader cursor (frozen or offset)
  const preferInstaloaderCursor = Boolean(
    cursor?.startsWith('ig_loader:') || cursor?.startsWith('ig_frozen:'),
  );

  // Tier 1A: RapidAPI Connector (skipped if continuing an Instaloader cursor)
  if (!preferInstaloaderCursor) {
    const rapidResult = await tryRapidApiExtraction(
      sourceUrl,
      contentType,
      parsed,
      jobId,
      safeLimit,
      cursor,
    );
    if (rapidResult && rapidResult.items.length > 0) {
      return {
        job: {
          id: jobId,
          sourceUrl,
          platform: 'instagram',
          contentType,
          contentLabel,
          status: 'ready',
          message: `Extracted ${rapidResult.items.length} media ${rapidResult.items.length === 1 ? 'file' : 'files'}.`,
          itemCount: rapidResult.items.length,
          resolverUsed: 'Instagram API Connector',
          hasMore: rapidResult.hasMore,
          nextCursor: rapidResult.nextCursor,
          pageNumber,
        },
        items: rapidResult.items,
      };
    }
  }

  // Tier 1B: Python Instaloader Engine (primary engine for Instagram workloads)
  if (!cursor || preferInstaloaderCursor) {
    const loaderResult = await tryInstaloaderExtraction(
      sourceUrl,
      contentType,
      parsed,
      jobId,
      safeLimit,
      cursor,
    );
    if (loaderResult && loaderResult.items.length > 0) {
      const resolvedLabel =
        (contentType === 'ig_post' || contentType === 'ig_reel') &&
        loaderResult.items.length > 1
          ? 'Instagram Carousel'
          : contentLabel;
      return {
        job: {
          id: jobId,
          sourceUrl,
          platform: 'instagram',
          contentType,
          contentLabel: resolvedLabel,
          status: 'ready',
          message: `Extracted ${loaderResult.items.length} media ${loaderResult.items.length === 1 ? 'file' : 'files'} via Python Instaloader.`,
          itemCount: loaderResult.items.length,
          totalAvailable: loaderResult.totalAvailable,
          resolverUsed: 'Python Instaloader',
          hasMore: loaderResult.hasMore,
          nextCursor: loaderResult.nextCursor,
          pageNumber,
        },
        items: loaderResult.items,
      };
    }
  }

  // Tier 1C: Direct Node Session Cookie Connector fallback
  const sessionResult = await trySessionCookieExtraction(
    sourceUrl,
    contentType,
    parsed,
    jobId,
    safeLimit,
    cursor,
  );
  if (sessionResult && sessionResult.items.length > 0) {
    return {
      job: {
        id: jobId,
        sourceUrl,
        platform: 'instagram',
        contentType,
        contentLabel,
        status: 'ready',
        message: `Extracted ${sessionResult.items.length} media ${sessionResult.items.length === 1 ? 'file' : 'files'}.`,
        itemCount: sessionResult.items.length,
        resolverUsed: 'Instagram Session Connector',
        hasMore: sessionResult.hasMore,
        nextCursor: sessionResult.nextCursor,
        pageNumber,
      },
      items: sessionResult.items,
    };
  }

  // Tier 2A: Public Instagram Profile extraction
  if (contentType === 'ig_profile' && parsed.username) {
    const publicProfileResult = await tryWebProfileInfo(
      parsed.username,
      sourceUrl,
      jobId,
      safeLimit,
    );
    if (publicProfileResult && publicProfileResult.items.length > 0) {
      return {
        job: {
          id: jobId,
          sourceUrl,
          platform: 'instagram',
          contentType,
          contentLabel,
          status: 'ready',
          message: `Extracted ${publicProfileResult.items.length} public media files from @${parsed.username}.`,
          itemCount: publicProfileResult.items.length,
          resolverUsed: 'Instagram Public Profile API',
          hasMore: publicProfileResult.hasMore,
          nextCursor: publicProfileResult.nextCursor,
          pageNumber,
        },
        items: publicProfileResult.items,
      };
    }

    return {
      job: {
        id: jobId,
        sourceUrl,
        platform: 'instagram',
        contentType,
        contentLabel,
        status: 'auth_required',
        message: hasServerAuth
          ? `Instagram declined or rate-limited the configured server connector for @${parsed.username}.`
          : `Instagram login-gated bulk profile reads for @${parsed.username} from this server IP. Configure INSTAGRAM_SESSION_ID or INSTAGRAM_RAPIDAPI_KEY on the server to pull public profile grids, stories, and highlights reliably.`,
        itemCount: 0,
        authHint: 'See Server Setup below for environment variable configuration.',
        hasMore: false,
        pageNumber,
      },
      items: [],
    };
  }

  if (contentType === 'ig_story' || contentType === 'ig_highlight') {
    return {
      job: {
        id: jobId,
        sourceUrl,
        platform: 'instagram',
        contentType,
        contentLabel,
        status: 'auth_required',
        message: hasServerAuth
          ? 'Instagram rejected or expired the configured server connector session for this Story/Highlight.'
          : 'Instagram restricts anonymous access to Stories and Highlights. Configure INSTAGRAM_SESSION_ID or INSTAGRAM_RAPIDAPI_KEY on the server to unlock live Story & Highlight extraction.',
        itemCount: 0,
        authHint: 'See Server Setup below for environment variable configuration.',
        hasMore: false,
        pageNumber,
      },
      items: [],
    };
  }

  if (parsed.shortcode) {
    const publicItems = await tryPublicPostExtraction(
      sourceUrl,
      contentType,
      parsed.shortcode,
      jobId,
    );
    if (publicItems && publicItems.length > 0) {
      return {
        job: {
          id: jobId,
          sourceUrl,
          platform: 'instagram',
          contentType,
          contentLabel:
            publicItems.length > 1 ? 'Instagram Carousel' : contentLabel,
          status: 'ready',
          message: `Extracted ${publicItems.length} media ${publicItems.length === 1 ? 'file' : 'files'}.`,
          itemCount: publicItems.length,
          resolverUsed: 'Instagram Public Embed',
          hasMore: false,
          pageNumber,
        },
        items: publicItems,
      };
    }
  }

  return {
    job: {
      id: jobId,
      sourceUrl,
      platform: 'instagram',
      contentType,
      contentLabel,
      status: 'auth_required',
      message:
        'Instagram rate-limited or login-gated this public post. If the account is private or currently throttled, configure INSTAGRAM_SESSION_ID or INSTAGRAM_RAPIDAPI_KEY on the server.',
      itemCount: 0,
      authHint: 'See Server Setup below for environment variable configuration.',
      hasMore: false,
      pageNumber,
    },
    items: [],
  };
}
