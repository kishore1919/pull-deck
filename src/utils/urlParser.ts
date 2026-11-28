import type { ContentType, ParsedUrlEntry, Platform } from '../types';

const INSTAGRAM_HOSTS = new Set([
  'instagram.com',
  'www.instagram.com',
  'm.instagram.com',
  'instagr.am',
  'www.instagr.am',
]);

const REDDIT_HOSTS = new Set([
  'reddit.com',
  'www.reddit.com',
  'old.reddit.com',
  'new.reddit.com',
  'm.reddit.com',
  'np.reddit.com',
  'redd.it',
  'www.redd.it',
  'v.redd.it',
  'i.redd.it',
]);

const REDGIFS_HOSTS = new Set([
  'redgifs.com',
  'www.redgifs.com',
  'v3.redgifs.com',
  'i.redgifs.com',
]);

const IG_RESERVED_PATHS = new Set([
  'p',
  'reel',
  'reels',
  'tv',
  'stories',
  'explore',
  'accounts',
  'direct',
  'api',
  'developer',
  'about',
  'legal',
  'privacy',
  'terms',
  's',
]);

export const CONTENT_TYPE_LABELS: Record<ContentType, string> = {
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
  unknown: 'Unsupported URL',
};

export function buildProfileUrl(platform: Platform, rawHandle: string): string {
  const trimmed = rawHandle.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;

  const clean = trimmed
    .replace(/^@+/, '')
    .replace(/^\/?(r|u|user|users)\//i, '')
    .replace(/\/.*$/, '')
    .trim();

  if (!clean) return '';

  if (platform === 'instagram') {
    return `https://www.instagram.com/${clean}/`;
  }
  if (platform === 'redgifs') {
    return `https://www.redgifs.com/users/${clean}`;
  }
  // Reddit: support r/subreddit if user typed r/..., otherwise u/username
  if (/^r\//i.test(trimmed)) {
    return `https://www.reddit.com/r/${clean}`;
  }
  return `https://www.reddit.com/user/${clean}`;
}

export function classifyUrl(rawInput: string): ParsedUrlEntry {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return {
      raw: rawInput,
      normalized: '',
      platform: null,
      contentType: 'unknown',
      label: CONTENT_TYPE_LABELS.unknown,
      valid: false,
      reason: 'Empty input',
    };
  }

  let candidate = trimmed;
  if (!/^https?:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return {
      raw: trimmed,
      normalized: trimmed,
      platform: null,
      contentType: 'unknown',
      label: CONTENT_TYPE_LABELS.unknown,
      valid: false,
      reason: 'Malformed URL format',
    };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      raw: trimmed,
      normalized: trimmed,
      platform: null,
      contentType: 'unknown',
      label: CONTENT_TYPE_LABELS.unknown,
      valid: false,
      reason: 'Only HTTP/HTTPS links are supported',
    };
  }

  const host = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname.replace(/\/+$/, '') || '/';

  // 1. Instagram
  if (INSTAGRAM_HOSTS.has(host)) {
    const platform: Platform = 'instagram';
    let contentType: ContentType = 'unknown';

    if (/^\/stories\/highlights\/[^/]+/i.test(pathname) || /^\/s\/[^/]+/i.test(pathname)) {
      contentType = 'ig_highlight';
    } else if (/^\/stories\/[^/]+(\/[^/]+)?/i.test(pathname)) {
      contentType = 'ig_story';
    } else if (/^\/(reel|reels|tv)\/[^/]+/i.test(pathname)) {
      contentType = 'ig_reel';
    } else if (/^\/p\/[^/]+/i.test(pathname) || /^\/[^/]+\/p\/[^/]+/i.test(pathname)) {
      contentType = 'ig_post';
    } else if (/^\/[^/]+\/reel\/[^/]+/i.test(pathname)) {
      contentType = 'ig_reel';
    } else {
      const profileMatch = pathname.match(/^\/([a-zA-Z0-9._]{1,30})(\/(reels|tagged|videos))?$/i);
      if (profileMatch && !IG_RESERVED_PATHS.has(profileMatch[1].toLowerCase())) {
        contentType = 'ig_profile';
      }
    }

    if (contentType === 'unknown') {
      return {
        raw: trimmed,
        normalized: parsed.toString(),
        platform,
        contentType,
        label: 'Instagram Link',
        valid: false,
        reason: 'Use a public profile, post (/p/), reel (/reel/), story, or highlight URL',
      };
    }

    const cleanUrl = new URL(parsed.toString());
    cleanUrl.searchParams.delete('igsh');
    cleanUrl.searchParams.delete('igshid');
    cleanUrl.searchParams.delete('utm_source');
    cleanUrl.searchParams.delete('utm_medium');

    return {
      raw: trimmed,
      normalized: cleanUrl.toString(),
      platform,
      contentType,
      label: CONTENT_TYPE_LABELS[contentType],
      valid: true,
    };
  }

  // 2. Reddit
  if (REDDIT_HOSTS.has(host)) {
    const platform: Platform = 'reddit';
    let contentType: ContentType = 'unknown';

    if (host === 'redd.it' || host === 'www.redd.it' || host === 'i.redd.it' || host === 'v.redd.it') {
      contentType = 'reddit_post';
    } else if (
      /^\/r\/[^/]+\/comments\/[^/]+/i.test(pathname) ||
      /^\/r\/[^/]+\/s\/[^/]+/i.test(pathname) ||
      /^\/comments\/[^/]+/i.test(pathname) ||
      /^\/gallery\/[^/]+/i.test(pathname)
    ) {
      contentType = 'reddit_post';
    } else if (/^\/r\/[^/]+(\/(hot|new|top|rising))?$/i.test(pathname)) {
      contentType = 'reddit_subreddit';
    } else if (/^\/(u|user)\/[^/]+(\/(submitted|posts|overview))?$/i.test(pathname)) {
      contentType = 'reddit_user';
    }

    if (contentType === 'unknown') {
      return {
        raw: trimmed,
        normalized: parsed.toString(),
        platform,
        contentType,
        label: 'Reddit Link',
        valid: false,
        reason: 'Use a Reddit profile (/u/...), subreddit (/r/...), post, or gallery URL',
      };
    }

    return {
      raw: trimmed,
      normalized: parsed.toString(),
      platform,
      contentType,
      label: CONTENT_TYPE_LABELS[contentType],
      valid: true,
    };
  }

  // 3. RedGIFs
  if (REDGIFS_HOSTS.has(host)) {
    const platform: Platform = 'redgifs';
    let contentType: ContentType = 'unknown';

    if (/^\/(watch|ifr)\/[a-zA-Z0-9_-]+/i.test(pathname)) {
      contentType = 'redgifs_clip';
    } else if (/^\/users\/[a-zA-Z0-9._-]+(\/(gifs|collections|likes))?$/i.test(pathname)) {
      contentType = 'redgifs_profile';
    }

    if (contentType === 'unknown') {
      return {
        raw: trimmed,
        normalized: parsed.toString(),
        platform,
        contentType,
        label: 'RedGIFs Link',
        valid: false,
        reason: 'Use a RedGIFs profile (/users/<name>) or clip (/watch/<id>) URL',
      };
    }

    return {
      raw: trimmed,
      normalized: parsed.toString(),
      platform,
      contentType,
      label: CONTENT_TYPE_LABELS[contentType],
      valid: true,
    };
  }

  return {
    raw: trimmed,
    normalized: parsed.toString(),
    platform: null,
    contentType: 'unknown',
    label: CONTENT_TYPE_LABELS.unknown,
    valid: false,
    reason: 'Supported platforms: Instagram, Reddit, and RedGIFs',
  };
}

export function isProfileOrFeedType(contentType: ContentType): boolean {
  return (
    contentType === 'ig_profile' ||
    contentType === 'reddit_user' ||
    contentType === 'reddit_subreddit' ||
    contentType === 'redgifs_profile'
  );
}

export function parseBulkUrls(input: string, maxUrls = 25): {
  entries: ParsedUrlEntry[];
  duplicateCount: number;
  truncatedCount: number;
} {
  const tokens = input
    .split(/[\r\n,\s]+/)
    .map((token) => token.trim())
    .filter(Boolean);

  const seen = new Set<string>();
  const uniqueEntries: ParsedUrlEntry[] = [];
  let duplicateCount = 0;

  for (const token of tokens) {
    const classified = classifyUrl(token);
    const dedupeKey = (classified.normalized || classified.raw).toLowerCase();
    if (seen.has(dedupeKey)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(dedupeKey);
    uniqueEntries.push(classified);
  }

  const truncatedCount = Math.max(0, uniqueEntries.length - maxUrls);
  return {
    entries: uniqueEntries.slice(0, maxUrls),
    duplicateCount,
    truncatedCount,
  };
}
