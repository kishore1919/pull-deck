import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ContentType } from '../../src/types.ts';
import { validateExternalUrl } from '../security.ts';

export interface InstaloaderWorkerRequest {
  contentType: ContentType;
  sourceUrl: string;
  username?: string;
  shortcode?: string;
  storyId?: string;
  highlightId?: string;
  limit: number;
  offset: number;
  frozenCursor?: string;
}

export interface InstaloaderRawItem {
  mediaType: 'image' | 'video';
  mediaUrl: string;
  thumbnailUrl: string;
  username: string;
  title: string;
  shortcodeOrId: string;
  sourceUrl: string;
  index: number;
  total: number;
  width?: number | null;
  height?: number | null;
  durationSec?: number | null;
  createdAt?: string | null;
}

export interface InstaloaderWorkerResult {
  ok: boolean;
  items?: InstaloaderRawItem[];
  hasMore?: boolean;
  nextOffset?: number | null;
  nextFrozenCursor?: string | null;
  totalAvailable?: number | null;
  authRequired?: boolean;
  rateLimited?: boolean;
  error?: string;
}

const WORKER_SCRIPT = path.resolve(
  process.cwd(),
  'server',
  'python',
  'instaloader_worker.py',
);
const WORKER_TIMEOUT_MS = 25_000;
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;

let cachedPythonBin: string | null | undefined;
let cachedVersion: string | null = null;

function candidatePythonBins(): string[] {
  const candidates: string[] = [];
  const envBin = process.env.PYTHON_BIN?.trim();
  if (envBin) {
    candidates.push(envBin);
  }
  const venvBin = path.resolve(process.cwd(), '.venv', 'bin', 'python');
  if (fs.existsSync(venvBin)) {
    candidates.push(venvBin);
  }
  candidates.push('python3');
  return candidates;
}

export function detectInstaloaderRuntime(): {
  available: boolean;
  pythonBin: string | null;
  version: string | null;
} {
  if (cachedPythonBin !== undefined) {
    return {
      available: cachedPythonBin !== null,
      pythonBin: cachedPythonBin,
      version: cachedVersion,
    };
  }

  if (!fs.existsSync(WORKER_SCRIPT)) {
    cachedPythonBin = null;
    cachedVersion = null;
    return { available: false, pythonBin: null, version: null };
  }

  for (const bin of candidatePythonBins()) {
    try {
      const check = spawnSync(
        bin,
        ['-c', 'import instaloader; print(instaloader.__version__)'],
        {
          shell: false,
          timeout: 4000,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      );
      if (check.status === 0 && check.stdout.trim()) {
        cachedPythonBin = bin;
        cachedVersion = check.stdout.trim();
        return {
          available: true,
          pythonBin: cachedPythonBin,
          version: cachedVersion,
        };
      }
    } catch {
      // Try next Python binary candidate
    }
  }

  cachedPythonBin = null;
  cachedVersion = null;
  return { available: false, pythonBin: null, version: null };
}

export async function runInstaloaderWorker(
  payload: InstaloaderWorkerRequest,
): Promise<InstaloaderWorkerResult | null> {
  const runtime = detectInstaloaderRuntime();
  if (!runtime.available || !runtime.pythonBin) {
    return null;
  }

  const childEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH || '',
    LANG: 'C.UTF-8',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1',
  };

  if (process.env.INSTAGRAM_SESSION_ID?.trim()) {
    childEnv.INSTAGRAM_SESSION_ID = process.env.INSTAGRAM_SESSION_ID.trim();
  }
  if (process.env.INSTAGRAM_USERNAME?.trim()) {
    childEnv.INSTAGRAM_USERNAME = process.env.INSTAGRAM_USERNAME.trim();
  }

  const rawResult = await new Promise<InstaloaderWorkerResult | null>((resolve) => {
    let settled = false;
    let stdoutBytes = 0;
    const chunks: Buffer[] = [];

    const child = spawn(runtime.pythonBin!, [WORKER_SCRIPT], {
      shell: false,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const finish = (val: InstaloaderWorkerResult | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(val);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({
        ok: false,
        error: 'Instaloader worker timed out while contacting Instagram.',
      });
    }, WORKER_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        child.kill('SIGKILL');
        finish({ ok: false, error: 'Instaloader output exceeded safety limit.' });
        return;
      }
      chunks.push(chunk);
    });

    // Drain stderr silently so child never blocks on pipe buffer
    child.stderr.on('data', () => {});

    child.on('error', () => {
      finish(null);
    });

    child.on('close', () => {
      if (settled) return;
      const output = Buffer.concat(chunks).toString('utf8').trim();
      if (!output) {
        finish(null);
        return;
      }
      try {
        const parsed = JSON.parse(output) as InstaloaderWorkerResult;
        finish(parsed);
      } catch {
        finish(null);
      }
    });

    try {
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    } catch {
      child.kill('SIGKILL');
      finish(null);
    }
  });

  if (!rawResult || !rawResult.ok || !Array.isArray(rawResult.items)) {
    return rawResult;
  }

  // Validate every returned media URL against the media host allowlist before returning
  const safeItems: InstaloaderRawItem[] = [];
  for (const item of rawResult.items) {
    try {
      const validMedia = await validateExternalUrl(item.mediaUrl, 'media');
      let validThumb = validMedia.toString();
      if (item.thumbnailUrl && item.thumbnailUrl !== item.mediaUrl) {
        try {
          validThumb = (await validateExternalUrl(item.thumbnailUrl, 'media')).toString();
        } catch {
          validThumb = validMedia.toString();
        }
      }
      safeItems.push({
        ...item,
        mediaUrl: validMedia.toString(),
        thumbnailUrl: validThumb,
      });
    } catch {
      // Skip any item whose media URL is outside allowed Instagram CDNs
    }
  }

  return {
    ...rawResult,
    ok: safeItems.length > 0,
    items: safeItems,
  };
}
