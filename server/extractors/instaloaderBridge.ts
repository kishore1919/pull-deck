import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
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
  cursor?: string;
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
  igCategory?: 'photo' | 'video' | 'reel' | 'dp' | 'highlight' | 'story' | null;
}

export interface InstaloaderWorkerResult {
  ok: boolean;
  items?: InstaloaderRawItem[];
  hasMore?: boolean;
  nextCursor?: string | null;
  nextOffset?: number | null;
  totalAvailable?: number | null;
  private?: boolean;
  notice?: string | null;
  rateLimited?: boolean;
  partial?: boolean;
  strategyUsed?: string | null;
  runtimeUnavailable?: boolean;
  error?: string;
}

export interface InstaloaderRuntimeInfo {
  available: boolean;
  pythonBin: string | null;
  version: string | null;
  bootstrapping?: boolean;
  reason?: string;
}

const WORKER_SCRIPT = path.resolve(
  process.cwd(),
  'server',
  'python',
  'instaloader_worker.py',
);
const REQUIREMENTS_FILE = path.resolve(process.cwd(), 'requirements.txt');
const WORKER_TIMEOUT_MS = 35_000;
const BOOTSTRAP_STEP_TIMEOUT_MS = 120_000;
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const GET_PIP_URL = 'https://bootstrap.pypa.io/get-pip.py';

// Portable standalone CPython 3.11 builds (zero root, zero apt, zero env vars)
const PORTABLE_PYTHON_URLS: Record<string, string> = {
  x64: 'https://github.com/astral-sh/python-build-standalone/releases/download/20241016/cpython-3.11.10+20241016-x86_64-unknown-linux-gnu-install_only.tar.gz',
  arm64:
    'https://github.com/astral-sh/python-build-standalone/releases/download/20241016/cpython-3.11.10+20241016-aarch64-unknown-linux-gnu-install_only.tar.gz',
};

let cachedPythonBin: string | null = null;
let cachedVersion: string | null = null;
let lastBootstrapError: string | null = null;
let lastBootstrapAttemptAt = 0;
let bootstrapPromise: Promise<InstaloaderRuntimeInfo> | null = null;

function venvPythonPath(venvDir: string): string {
  return process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python');
}

function portablePythonDir(): string {
  return path.join(os.tmpdir(), 'pulldeck-python');
}

function portablePythonBinPath(): string {
  return path.join(portablePythonDir(), 'python', 'bin', 'python3');
}

const SYSTEM_PYTHON_PATHS = [
  'python3',
  '/usr/bin/python3',
  '/usr/local/bin/python3',
  '/bin/python3',
  '/opt/homebrew/bin/python3',
  'python',
];

function candidatePythonBins(): string[] {
  const candidates: string[] = [];

  const projectVenv = path.resolve(process.cwd(), '.venv');
  const tmpVenv = path.join(os.tmpdir(), 'pulldeck-venv');
  for (const dir of [projectVenv, tmpVenv]) {
    const pyPath = venvPythonPath(dir);
    if (fs.existsSync(pyPath)) {
      candidates.push(pyPath);
    }
  }

  const portablePy = portablePythonBinPath();
  if (fs.existsSync(portablePy)) {
    candidates.push(portablePy);
  }

  for (const bin of SYSTEM_PYTHON_PATHS) {
    if (!path.isAbsolute(bin) || fs.existsSync(bin)) {
      candidates.push(bin);
    }
  }
  return Array.from(new Set(candidates));
}

function findBasePythonBin(): string | null {
  const portablePy = portablePythonBinPath();
  if (fs.existsSync(portablePy)) {
    return portablePy;
  }

  for (const bin of SYSTEM_PYTHON_PATHS) {
    if (path.isAbsolute(bin) && !fs.existsSync(bin)) continue;
    try {
      const check = spawnSync(bin, ['--version'], {
        shell: false,
        timeout: 4000,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const verOut = `${check.stdout || ''} ${check.stderr || ''}`;
      if (check.status === 0 && /Python 3\./i.test(verOut)) {
        return bin;
      }
    } catch {
      // try next candidate
    }
  }

  return null;
}

function runCommandAsync(
  bin: string,
  args: string[],
  timeoutMs = BOOTSTRAP_STEP_TIMEOUT_MS,
): Promise<{ ok: boolean; code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    let settled = false;
    let stderr = '';

    const child = spawn(bin, args, {
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    const finish = (ok: boolean, code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, code, stderr: stderr.trim().slice(-400) });
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(false, null);
    }, timeoutMs);

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) {
        stderr += chunk.toString('utf8');
      }
    });

    child.on('error', (err) => {
      stderr = err.message;
      finish(false, null);
    });

    child.on('close', (code) => {
      finish(code === 0, code);
    });
  });
}

function chooseWritableVenvDir(): string {
  const projectVenv = path.resolve(process.cwd(), '.venv');
  try {
    fs.accessSync(process.cwd(), fs.constants.W_OK);
    return projectVenv;
  } catch {
    return path.join(os.tmpdir(), 'pulldeck-venv');
  }
}

/**
 * Automatically downloads a self-contained portable Python 3.11 runtime into /tmp
 * when running on a minimal Node-only Linux container without system python3.
 */
async function ensurePortablePythonRuntime(): Promise<string | null> {
  const existing = portablePythonBinPath();
  if (fs.existsSync(existing)) {
    return existing;
  }

  if (process.platform !== 'linux') {
    return null;
  }

  const downloadUrl = PORTABLE_PYTHON_URLS[process.arch];
  if (!downloadUrl) {
    return null;
  }

  const targetDir = portablePythonDir();
  const tmpArchive = path.join(
    os.tmpdir(),
    `pulldeck-cpython-${crypto.randomUUID()}.tar.gz`,
  );

  try {
    const resp = await fetch(downloadUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(60_000),
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} downloading portable Python runtime`);
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(tmpArchive, buf);
    fs.mkdirSync(targetDir, { recursive: true });

    const extract = await runCommandAsync(
      'tar',
      ['-xzf', tmpArchive, '-C', targetDir],
      60_000,
    );
    if (!extract.ok || !fs.existsSync(existing)) {
      throw new Error(extract.stderr || 'Failed to unpack portable Python archive');
    }
    return existing;
  } catch (err) {
    lastBootstrapError =
      err instanceof Error
        ? `Portable Python bootstrap failed: ${err.message}`
        : 'Portable Python bootstrap failed.';
    return null;
  } finally {
    fs.rmSync(tmpArchive, { force: true });
  }
}

export function detectInstaloaderRuntime(): InstaloaderRuntimeInfo {
  if (
    cachedPythonBin &&
    (!path.isAbsolute(cachedPythonBin) || fs.existsSync(cachedPythonBin))
  ) {
    return {
      available: true,
      pythonBin: cachedPythonBin,
      version: cachedVersion,
    };
  }

  if (!fs.existsSync(WORKER_SCRIPT)) {
    return {
      available: false,
      pythonBin: null,
      version: null,
      reason: 'Instaloader worker script is missing.',
    };
  }

  for (const bin of candidatePythonBins()) {
    try {
      const check = spawnSync(
        bin,
        ['-c', 'import instaloader; print(instaloader.__version__)'],
        {
          shell: false,
          timeout: 5000,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      );
      if (check.status === 0 && check.stdout.trim()) {
        cachedPythonBin = bin;
        cachedVersion = check.stdout.trim();
        lastBootstrapError = null;
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

  return {
    available: false,
    pythonBin: null,
    version: null,
    bootstrapping: Boolean(bootstrapPromise),
    reason: lastBootstrapError || undefined,
  };
}

async function performAutoBootstrap(): Promise<InstaloaderRuntimeInfo> {
  const existing = detectInstaloaderRuntime();
  if (existing.available) return existing;

  let basePy = findBasePythonBin();
  let usingPortable = false;

  if (!basePy) {
    basePy = await ensurePortablePythonRuntime();
    usingPortable = Boolean(basePy);
  }

  if (!basePy) {
    lastBootstrapError =
      lastBootstrapError ||
      'Python 3 runtime could not be located or bootstrapped on this container.';
    return {
      available: false,
      pythonBin: null,
      version: null,
      reason: lastBootstrapError,
    };
  }

  const targetPy = usingPortable ? basePy : venvPythonPath(chooseWritableVenvDir());

  try {
    // Step 1: Create virtual environment when using system Python
    if (!usingPortable) {
      const venvDir = chooseWritableVenvDir();
      if (!fs.existsSync(targetPy)) {
        const stdVenv = await runCommandAsync(basePy, ['-m', 'venv', venvDir]);
        if (!stdVenv.ok || !fs.existsSync(targetPy)) {
          fs.rmSync(venvDir, { recursive: true, force: true });
          const noPipVenv = await runCommandAsync(basePy, [
            '-m',
            'venv',
            '--without-pip',
            venvDir,
          ]);
          if (!noPipVenv.ok || !fs.existsSync(targetPy)) {
            lastBootstrapError = `Could not create Python virtual environment: ${noPipVenv.stderr || stdVenv.stderr || 'venv failed'}`;
            return {
              available: false,
              pythonBin: null,
              version: null,
              reason: lastBootstrapError,
            };
          }
        }
      }
    }

    // Step 2: Ensure pip exists inside target Python
    const pipCheck = await runCommandAsync(targetPy, ['-m', 'pip', '--version'], 10_000);
    if (!pipCheck.ok) {
      const tmpPipScript = path.join(
        os.tmpdir(),
        `pulldeck-get-pip-${crypto.randomUUID()}.py`,
      );
      try {
        const resp = await fetch(GET_PIP_URL, {
          signal: AbortSignal.timeout(20_000),
        });
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status} downloading get-pip.py`);
        }
        const scriptBuf = Buffer.from(await resp.arrayBuffer());
        fs.writeFileSync(tmpPipScript, scriptBuf, { mode: 0o600 });
        const installPip = await runCommandAsync(targetPy, [tmpPipScript, '--quiet']);
        if (!installPip.ok) {
          throw new Error(installPip.stderr || 'get-pip installation failed');
        }
      } finally {
        fs.rmSync(tmpPipScript, { force: true });
      }
    }

    // Step 3: Install instaloader>=4.16 from requirements.txt
    const pipArgs = fs.existsSync(REQUIREMENTS_FILE)
      ? ['-m', 'pip', 'install', '--quiet', '--no-input', '-r', REQUIREMENTS_FILE]
      : ['-m', 'pip', 'install', '--quiet', '--no-input', 'instaloader>=4.16,<5.0'];

    const installDeps = await runCommandAsync(targetPy, pipArgs);
    if (!installDeps.ok) {
      lastBootstrapError = `Failed to install Python Instaloader: ${installDeps.stderr || 'pip install failed'}`;
      return {
        available: false,
        pythonBin: null,
        version: null,
        reason: lastBootstrapError,
      };
    }

    const verified = detectInstaloaderRuntime();
    if (!verified.available) {
      lastBootstrapError = 'Instaloader installed but could not be imported.';
      return { ...verified, reason: lastBootstrapError };
    }
    return verified;
  } catch (err) {
    lastBootstrapError =
      err instanceof Error
        ? `Instaloader auto-setup failed: ${err.message}`
        : 'Instaloader auto-setup failed.';
    return {
      available: false,
      pythonBin: null,
      version: null,
      reason: lastBootstrapError,
    };
  }
}

/**
 * Ensures Python Instaloader is available with zero environment variables,
 * automatically bootstrapping .venv, /tmp/pulldeck-venv, or a portable
 * standalone Python 3.11 runtime on minimal Node-only containers.
 */
export async function ensureInstaloaderRuntime(): Promise<InstaloaderRuntimeInfo> {
  const current = detectInstaloaderRuntime();
  if (current.available) return current;

  if (bootstrapPromise) {
    return bootstrapPromise;
  }

  const now = Date.now();
  if (lastBootstrapAttemptAt > 0 && now - lastBootstrapAttemptAt < 60_000) {
    return {
      available: false,
      pythonBin: null,
      version: null,
      reason: lastBootstrapError || undefined,
    };
  }

  lastBootstrapAttemptAt = now;
  bootstrapPromise = performAutoBootstrap().finally(() => {
    bootstrapPromise = null;
  });
  return bootstrapPromise;
}

function parseWorkerJsonOutput(output: string): InstaloaderWorkerResult | null {
  const trimmed = output.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed) as InstaloaderWorkerResult;
  } catch {
    const lines = trimmed.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const candidate = lines[i].trim();
      if (candidate.startsWith('{') && candidate.endsWith('}')) {
        try {
          return JSON.parse(candidate) as InstaloaderWorkerResult;
        } catch {
          // continue searching
        }
      }
    }
    return null;
  }
}

export async function runInstaloaderWorker(
  payload: InstaloaderWorkerRequest,
): Promise<InstaloaderWorkerResult> {
  const runtime = await ensureInstaloaderRuntime();
  if (!runtime.available || !runtime.pythonBin) {
    return {
      ok: false,
      runtimeUnavailable: true,
      error:
        runtime.reason ||
        'Python Instaloader runtime is not available on this server.',
    };
  }

  const childEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH || '',
    LANG: 'C.UTF-8',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1',
  };

  const rawResult = await new Promise<InstaloaderWorkerResult>((resolve) => {
    let settled = false;
    let stdoutBytes = 0;
    let stderrText = '';
    const chunks: Buffer[] = [];

    const child = spawn(runtime.pythonBin!, [WORKER_SCRIPT], {
      shell: false,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const finish = (val: InstaloaderWorkerResult) => {
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

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrText.length < 1024) {
        stderrText += chunk.toString('utf8');
      }
    });

    child.on('error', (err) => {
      finish({
        ok: false,
        runtimeUnavailable: true,
        error: `Failed to start Python Instaloader process: ${err.message}`,
      });
    });

    child.on('close', (code) => {
      if (settled) return;
      const output = Buffer.concat(chunks).toString('utf8');
      const parsed = parseWorkerJsonOutput(output);
      if (parsed) {
        finish(parsed);
        return;
      }
      const errDetail = stderrText.trim().split(/\r?\n/).pop();
      finish({
        ok: false,
        error: errDetail
          ? `Instaloader worker failed: ${errDetail.slice(0, 180)}`
          : `Instaloader worker exited unexpectedly (code ${code ?? 'unknown'}).`,
      });
    });

    try {
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    } catch {
      child.kill('SIGKILL');
      finish({
        ok: false,
        error: 'Failed to send request to Instaloader worker.',
      });
    }
  });

  if (!rawResult.ok || !Array.isArray(rawResult.items)) {
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
