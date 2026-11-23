import dns from 'node:dns/promises';
import net from 'node:net';

const EXTRACT_HOST_SUFFIXES = [
  'instagram.com',
  'instagr.am',
  'reddit.com',
  'redd.it',
  'arctic-shift.photon-reddit.com',
  'redgifs.com',
];

const MEDIA_HOST_SUFFIXES = [
  'cdninstagram.com',
  'fbcdn.net',
  'instagram.com',
  'redd.it',
  'reddit.com',
  'redditmedia.com',
  'redditstatic.com',
  'i.imgur.com',
  'redgifs.com',
];

export type UrlValidationMode = 'extract' | 'media' | 'rapidapi';

export function isPrivateOrReservedIp(ip: string): boolean {
  const normalized = ip.toLowerCase().trim();

  // Handle IPv4-mapped IPv6 addresses like ::ffff:127.0.0.1
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice(7);
    if (net.isIPv4(mapped)) {
      return isPrivateOrReservedIp(mapped);
    }
  }

  if (net.isIPv4(normalized)) {
    const parts = normalized.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
      return true;
    }
    const [a, b] = parts;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a >= 224) return true; // Multicast & reserved
    return false;
  }

  if (net.isIPv6(normalized)) {
    if (normalized === '::' || normalized === '::1') return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // ULA fc00::/7
    if (
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb')
    ) {
      return true; // Link-local fe80::/10
    }
    if (normalized.startsWith('ff')) return true; // Multicast
    return false;
  }

  return true;
}

function hostMatchesAllowlist(hostname: string, mode: UrlValidationMode): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    return false;
  }

  // Never allow raw IP literals in allowlisted domains
  if (net.isIP(host) !== 0) {
    return false;
  }

  if (mode === 'rapidapi') {
    return host.endsWith('.p.rapidapi.com') && host.length > '.p.rapidapi.com'.length;
  }

  const list = mode === 'extract' ? EXTRACT_HOST_SUFFIXES : MEDIA_HOST_SUFFIXES;
  return list.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

export async function validateExternalUrl(
  rawUrl: string,
  mode: UrlValidationMode,
): Promise<URL> {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 2048) {
    throw new Error('URL is missing or exceeds maximum length.');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL syntax.');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Only HTTP and HTTPS URLs are permitted.');
  }

  if (parsed.username || parsed.password) {
    throw new Error('URLs with embedded credentials are not permitted.');
  }

  if (!hostMatchesAllowlist(parsed.hostname, mode)) {
    throw new Error(`Host "${parsed.hostname}" is not in the supported allowlist.`);
  }

  // Verify DNS resolution does not point to private, loopback, or metadata IPs
  try {
    const records = await dns.lookup(parsed.hostname, { all: true });
    if (!records.length) {
      throw new Error('Hostname could not be resolved.');
    }
    for (const record of records) {
      if (isPrivateOrReservedIp(record.address)) {
        throw new Error('Target address resolves to a restricted network range.');
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('restricted network range')) {
      throw err;
    }
    // If DNS lookup fails completely, fetch will also fail; rethrow clearly
    throw new Error(`Could not resolve host "${parsed.hostname}".`);
  }

  return parsed;
}

export async function safeFetch(
  rawUrl: string,
  mode: UrlValidationMode,
  init: RequestInit = {},
  timeoutMs = 12000,
  maxRedirects = 4,
): Promise<{ response: Response; finalUrl: string }> {
  let currentUrl = rawUrl;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const validated = await validateExternalUrl(currentUrl, mode);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(validated.toString(), {
        ...init,
        redirect: 'manual',
        signal: controller.signal,
      });

      if (
        response.status >= 300 &&
        response.status < 400 &&
        response.headers.get('location')
      ) {
        const location = response.headers.get('location')!;
        // Consume/cancel body to avoid leaking sockets
        await response.body?.cancel().catch(() => {});
        const nextUrl = new URL(location, validated.toString()).toString();
        currentUrl = nextUrl;
        continue;
      }

      return { response, finalUrl: validated.toString() };
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error('Too many redirects while contacting upstream host.');
}

export function sanitizeFolderSegment(segment: string, fallback = 'misc'): string {
  const cleaned = segment
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/\.{2,}/g, '_')
    .slice(0, 48);
  return cleaned || fallback;
}

export function sanitizeFilename(rawName: string, fallbackExt = 'jpg'): string {
  const safeExt = fallbackExt.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6) || 'jpg';
  const stripped = rawName
    .replace(/[/\\?%*:|"<>]/g, '_')
    .replace(/\.\.+/g, '.')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^[_.-]+|[_.-]+$/g, '');

  const hasKnownExt = /\.(jpg|jpeg|png|webp|gif|mp4|webm)$/i.test(stripped);
  const base = hasKnownExt ? stripped.replace(/\.[^.]+$/, '') : stripped;
  const ext = hasKnownExt ? stripped.split('.').pop()!.toLowerCase() : safeExt;
  const trimmedBase = (base || 'media_file').slice(0, 72);

  return `${trimmedBase}.${ext}`;
}
