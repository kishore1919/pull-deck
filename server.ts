import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { ZipArchive } from 'archiver';
import express from 'express';
import type {
  BatchExtractRequest,
  BatchExtractResponse,
  CapabilitiesResponse,
  ExtractionJob,
  MediaItem,
  ZipDownloadRequest,
} from './src/types.ts';
import { classifyUrl } from './src/utils/urlParser.ts';
import { extractInstagramUrl } from './server/extractors/instagram.ts';
import {
  detectInstaloaderRuntime,
  ensureInstaloaderRuntime,
} from './server/extractors/instaloaderBridge.ts';
import { extractRedditUrl } from './server/extractors/reddit.ts';
import { extractRedgifsUrl } from './server/extractors/redgifs.ts';
import {
  safeFetch,
  sanitizeFilename,
  sanitizeFolderSegment,
} from './server/security.ts';

const PORT = Number(process.env.PORT) || 3000;
const MAX_BATCH_URLS = 25;
const MAX_ZIP_ITEMS = 50;
const MAX_ZIP_VIDEO_ITEMS = 12;
const MAX_PROFILE_LIMIT = 500;
const PLATFORM_OPTIMAL_PAGE_SIZE = {
  reddit: 100,
  redgifs: 80,
  instagram: 30,
} as const;
const EXTRACT_CONCURRENCY = 4;
const ALLOWED_PROXY_CONTENT_TYPES = [
  'image/',
  'video/',
  'application/octet-stream',
];

function buildUpstreamMediaHeaders(mediaUrl: string): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Accept: 'image/*,video/*,*/*;q=0.8',
  };
  try {
    const host = new URL(mediaUrl).hostname.toLowerCase();
    if (host === 'redgifs.com' || host.endsWith('.redgifs.com')) {
      headers.Referer = 'https://www.redgifs.com/';
      headers.Origin = 'https://www.redgifs.com';
    }
  } catch {
    // ignore
  }
  return headers;
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function next() {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      results[idx] = await worker(items[idx]);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => next());
  await Promise.all(workers);
  return results;
}

async function startServer() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  // 1. Server Connector Capabilities (Booleans only, never exposes secrets)
  app.get('/api/capabilities', (_req, res) => {
    const instaloaderRuntime = detectInstaloaderRuntime();
    const payload: CapabilitiesResponse = {
      redditPublic: true,
      redgifsPublic: true,
      instagramPublic: true,
      instagramInstaloaderAvailable: instaloaderRuntime.available,
      instagramInstaloaderVersion: instaloaderRuntime.version,
      maxBatchUrls: MAX_BATCH_URLS,
      maxZipItems: MAX_ZIP_ITEMS,
      maxZipVideoItems: MAX_ZIP_VIDEO_ITEMS,
      maxProfileLimit: MAX_PROFILE_LIMIT,
    };
    res.setHeader('Cache-Control', 'no-store');
    res.json(payload);
  });

  // 2. Single, Profile (Paginated) & Bulk URL Extraction
  app.post('/api/extract/batch', async (req, res) => {
    const body = req.body as Partial<BatchExtractRequest> | undefined;
    if (!body || !Array.isArray(body.urls) || body.urls.length === 0) {
      res.status(400).json({ error: 'Provide at least one Instagram, Reddit, or RedGIFs URL.' });
      return;
    }

    const rawUrls = body.urls
      .filter((u): u is string => typeof u === 'string' && u.trim().length > 0)
      .slice(0, MAX_BATCH_URLS);

    if (rawUrls.length === 0) {
      res.status(400).json({ error: 'No valid URL strings provided.' });
      return;
    }

    const explicitLimit =
      typeof body.subredditLimit === 'number' && Number.isFinite(body.subredditLimit)
        ? Math.min(Math.max(Math.floor(body.subredditLimit), 1), MAX_PROFILE_LIMIT)
        : undefined;
    const profileSort =
      body.subredditSort === 'top' || body.subredditSort === 'hot'
        ? body.subredditSort
        : 'new';
    const cursor =
      typeof body.cursor === 'string' && body.cursor.length <= 16384
        ? body.cursor
        : undefined;
    const pageNumber =
      typeof body.pageNumber === 'number' &&
      Number.isInteger(body.pageNumber) &&
      body.pageNumber >= 1 &&
      body.pageNumber <= 500
        ? body.pageNumber
        : 1;

    const results = await runWithConcurrency(
      rawUrls,
      EXTRACT_CONCURRENCY,
      async (rawUrl): Promise<{ job: ExtractionJob; items: MediaItem[] }> => {
        const jobId = crypto.randomUUID();
        const classified = classifyUrl(rawUrl);

        if (!classified.valid || !classified.platform) {
          return {
            job: {
              id: jobId,
              sourceUrl: rawUrl,
              platform: classified.platform,
              contentType: classified.contentType,
              contentLabel: classified.label,
              status: 'error',
              message: classified.reason || 'Unsupported URL format.',
              itemCount: 0,
            },
            items: [],
          };
        }

        const effectiveCursor = rawUrls.length === 1 ? cursor : undefined;
        const pageLimit =
          explicitLimit ?? PLATFORM_OPTIMAL_PAGE_SIZE[classified.platform];

        if (classified.platform === 'reddit') {
          return extractRedditUrl(
            classified.normalized,
            classified.contentType,
            jobId,
            pageLimit,
            profileSort,
            effectiveCursor,
            pageNumber,
          );
        }

        if (classified.platform === 'redgifs') {
          return extractRedgifsUrl(
            classified.normalized,
            classified.contentType,
            jobId,
            pageLimit,
            profileSort,
            effectiveCursor,
            pageNumber,
          );
        }

        return extractInstagramUrl(
          classified.normalized,
          classified.contentType,
          jobId,
          pageLimit,
          effectiveCursor,
          pageNumber,
        );
      },
    );

    const responsePayload: BatchExtractResponse = {
      jobs: results.map((r) => r.job),
      items: results.flatMap((r) => r.items),
      processedAt: new Date().toISOString(),
    };

    res.setHeader('Cache-Control', 'no-store');
    res.json(responsePayload);
  });

  // 3. Stateless Media Stream Proxy (for thumbnail previews & direct single-file downloads)
  app.get('/api/proxy', async (req, res) => {
    const rawUrl = typeof req.query.url === 'string' ? req.query.url : '';
    const isDownload = req.query.download === '1' || req.query.download === 'true';
    const requestedName =
      typeof req.query.filename === 'string' ? req.query.filename : 'pulldeck_media';

    if (!rawUrl) {
      res.status(400).json({ error: 'Missing media URL.' });
      return;
    }

    try {
      const { response } = await safeFetch(
        rawUrl,
        'media',
        {
          headers: buildUpstreamMediaHeaders(rawUrl),
        },
        15000,
      );

      if (!response.ok || !response.body) {
        res.status(502).json({ error: `Upstream media host returned HTTP ${response.status}.` });
        return;
      }

      const contentType = (
        response.headers.get('content-type') || 'application/octet-stream'
      ).toLowerCase();

      const allowedType = ALLOWED_PROXY_CONTENT_TYPES.some((prefix) =>
        contentType.startsWith(prefix),
      );
      if (!allowedType) {
        await response.body.cancel().catch(() => {});
        res.status(415).json({ error: 'Upstream host did not return a valid media stream.' });
        return;
      }

      const contentLength = Number(response.headers.get('content-length') || 0);
      if (contentLength > 80 * 1024 * 1024) {
        await response.body.cancel().catch(() => {});
        res.status(413).json({ error: 'Media asset exceeds the 80 MB single-file proxy limit.' });
        return;
      }

      res.setHeader('Content-Type', contentType);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', isDownload ? 'no-store' : 'private, max-age=300');

      if (contentLength > 0) {
        res.setHeader('Content-Length', String(contentLength));
      }

      if (isDownload) {
        const inferredExt = contentType.includes('mp4')
          ? 'mp4'
          : contentType.includes('png')
            ? 'png'
            : contentType.includes('webp')
              ? 'webp'
              : contentType.includes('gif')
                ? 'gif'
                : 'jpg';
        const safeName = sanitizeFilename(requestedName, inferredExt);
        res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
      }

      const nodeStream = Readable.fromWeb(
        response.body as unknown as WebReadableStream,
      );
      nodeStream.on('error', () => {
        if (!res.headersSent) {
          res.status(502).end();
        } else {
          res.end();
        }
      });
      nodeStream.pipe(res);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Unable to stream media asset.',
      });
    }
  });

  // 4. On-the-Fly Stateless ZIP Bundle Streamer
  app.post('/api/download/zip', async (req, res) => {
    const body = req.body as Partial<ZipDownloadRequest> | undefined;
    if (!body || !Array.isArray(body.items) || body.items.length === 0) {
      res.status(400).json({ error: 'Select at least one media item to bundle.' });
      return;
    }

    const items = body.items.slice(0, MAX_ZIP_ITEMS);
    const organizeByFolder = body.options?.organizeByFolder !== false;
    const includeMetadataJson = Boolean(body.options?.includeMetadataJson);
    const safePartLabel =
      typeof body.partLabel === 'string'
        ? body.partLabel.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32)
        : '';

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const archiveFilename = safePartLabel
      ? `pulldeck-${safePartLabel}-${timestamp}.zip`
      : `pulldeck-bundle-${timestamp}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${archiveFilename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const archive = new ZipArchive({ zlib: { level: 5 } });
    archive.on('error', () => {
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed while packaging ZIP stream.' });
      } else {
        res.end();
      }
    });
    archive.pipe(res);

    const usedPaths = new Set<string>();
    const manifestEntries: Array<Record<string, unknown>> = [];
    const skippedNotes: string[] = [];
    const MAX_SINGLE_ZIP_FILE_BYTES = 80 * 1024 * 1024;
    const MAX_TOTAL_ZIP_BYTES = 300 * 1024 * 1024;
    let totalBundledBytes = 0;

    for (const item of items) {
      try {
        const { response } = await safeFetch(
          item.mediaUrl,
          'media',
          {
            headers: buildUpstreamMediaHeaders(item.mediaUrl),
          },
          15000,
        );

        if (!response.ok || !response.body) {
          skippedNotes.push(
            `${item.filename}: upstream returned HTTP ${response.status}`,
          );
          continue;
        }

        const contentType = (response.headers.get('content-type') || '').toLowerCase();
        const allowedType = ALLOWED_PROXY_CONTENT_TYPES.some((prefix) =>
          contentType.startsWith(prefix),
        );
        if (!allowedType) {
          await response.body.cancel().catch(() => {});
          skippedNotes.push(`${item.filename}: unsupported upstream content-type`);
          continue;
        }

        const declaredBytes = Number(response.headers.get('content-length') || 0);
        if (
          declaredBytes > MAX_SINGLE_ZIP_FILE_BYTES ||
          totalBundledBytes + declaredBytes > MAX_TOTAL_ZIP_BYTES
        ) {
          await response.body.cancel().catch(() => {});
          skippedNotes.push(`${item.filename}: exceeded bundle size limit`);
          continue;
        }

        const fallbackExt = item.mediaType === 'video' ? 'mp4' : 'jpg';
        const safeName = sanitizeFilename(item.filename, fallbackExt);
        const folderPrefix = organizeByFolder
          ? `${sanitizeFolderSegment(item.platform)}/${sanitizeFolderSegment(item.sourceContainer, 'media')}/`
          : '';

        let entryPath = `${folderPrefix}${safeName}`;
        let dedupeIndex = 2;
        while (usedPaths.has(entryPath.toLowerCase())) {
          const extMatch = safeName.match(/(\.[^.]+)$/);
          const ext = extMatch ? extMatch[1] : '';
          const stem = ext ? safeName.slice(0, -ext.length) : safeName;
          entryPath = `${folderPrefix}${stem}_${dedupeIndex}${ext}`;
          dedupeIndex += 1;
        }
        usedPaths.add(entryPath.toLowerCase());

        const arrayBuf = await response.arrayBuffer();
        if (
          arrayBuf.byteLength > MAX_SINGLE_ZIP_FILE_BYTES ||
          totalBundledBytes + arrayBuf.byteLength > MAX_TOTAL_ZIP_BYTES
        ) {
          skippedNotes.push(`${item.filename}: exceeded bundle size limit`);
          continue;
        }
        totalBundledBytes += arrayBuf.byteLength;
        archive.append(Buffer.from(arrayBuf), { name: entryPath });

        manifestEntries.push({
          archivePath: entryPath,
          platform: item.platform,
          sourceContainer: item.sourceContainer,
          author: item.author,
          title: item.title,
          mediaType: item.mediaType,
          sourceUrl: item.sourceUrl,
        });
      } catch (err) {
        skippedNotes.push(
          `${item.filename}: ${err instanceof Error ? err.message : 'fetch error'}`,
        );
      }
    }

    if (includeMetadataJson) {
      archive.append(
        JSON.stringify(
          {
            exportedBy: 'PullDeck (Stateless Session)',
            exportedAt: new Date().toISOString(),
            totalPackaged: manifestEntries.length,
            files: manifestEntries,
          },
          null,
          2,
        ),
        { name: 'metadata.json' },
      );
    }

    if (skippedNotes.length > 0) {
      archive.append(
        `Some remote media links could not be bundled:\n\n${skippedNotes.join('\n')}\n`,
        { name: 'download-notes.txt' },
      );
    }

    await archive.finalize();
  });

  // 5. Frontend Serving (Vite middleware in dev, dist/ static in prod)
  const isProduction = process.env.NODE_ENV === 'production';
  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      const indexHtml = path.join(distDir, 'index.html');
      if (fs.existsSync(indexHtml)) {
        res.sendFile(indexHtml);
      } else {
        res.status(404).send('Build output not found.');
      }
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`PullDeck server listening on http://0.0.0.0:${PORT}`);
    // Automatically prepare Python Instaloader venv in background on fresh containers
    void ensureInstaloaderRuntime();
  });
}

startServer().catch((err) => {
  console.error('Failed to start PullDeck server:', err);
  process.exit(1);
});
