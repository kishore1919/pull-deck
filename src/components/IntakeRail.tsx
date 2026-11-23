import { useMemo, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  Check,
  ChevronDown,
  ClipboardPaste,
  Copy,
  FileUp,
  KeyRound,
  Layers,
  Loader2,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import type { CapabilitiesResponse, Platform, ZipOptions } from '../types';
import {
  buildProfileUrl,
  classifyUrl,
  parseBulkUrls,
} from '../utils/urlParser';

export type IntakeMode = 'single' | 'bulk';

interface IntakeRailProps {
  platform: Platform;
  mode: IntakeMode;
  onModeChange: (mode: IntakeMode) => void;
  rawInput: string;
  onRawInputChange: (val: string) => void;
  subredditLimit: number;
  onSubredditLimitChange: (limit: number) => void;
  subredditSort: 'hot' | 'top' | 'new';
  onSubredditSortChange: (sort: 'hot' | 'top' | 'new') => void;
  zipOptions: ZipOptions;
  onZipOptionsChange: (options: ZipOptions) => void;
  isExtracting: boolean;
  onExtract: (urls: string[]) => void;
  capabilities: CapabilitiesResponse | null;
}

const PLATFORM_CONFIG: Record<
  Platform,
  {
    placeholder: string;
    bulkPlaceholder: string;
    limits: number[];
    supportsSort: boolean;
    examples: Array<{ label: string; input: string }>;
  }
> = {
  instagram: {
    placeholder: '@username, profile URL, post, reel, story, or highlight link',
    bulkPlaceholder:
      'https://www.instagram.com/username/\nhttps://www.instagram.com/p/...\nhttps://www.instagram.com/stories/username/',
    limits: [12, 25, 50, 100],
    supportsSort: false,
    examples: [],
  },
  reddit: {
    placeholder: 'u/username, r/subreddit, or reddit.com post / profile URL',
    bulkPlaceholder:
      'https://www.reddit.com/r/EarthPorn\nhttps://www.reddit.com/user/nasa\nhttps://www.reddit.com/r/ArchitecturePorn',
    limits: [25, 50, 100],
    supportsSort: true,
    examples: [
      { label: 'r/EarthPorn', input: 'r/EarthPorn' },
      { label: 'u/nasa', input: 'u/nasa' },
    ],
  },
  redgifs: {
    placeholder: 'username, redgifs.com/users/username, or clip URL',
    bulkPlaceholder:
      'https://www.redgifs.com/users/username\nhttps://www.redgifs.com/watch/...',
    limits: [25, 50, 80],
    supportsSort: true,
    examples: [],
  },
};

const IG_ENV_SNIPPET = `# Server Secrets (.env) for Instagram Stories, Highlights & Profiles
INSTAGRAM_SESSION_ID="your_sessionid_cookie"
INSTAGRAM_USERNAME="your_secondary_ig_handle"

# Or managed RapidAPI connector:
INSTAGRAM_RAPIDAPI_KEY="your_rapidapi_key"
INSTAGRAM_RAPIDAPI_HOST="instagram-scraper-api2.p.rapidapi.com"`;

function looksLikeExplicitUrl(val: string): boolean {
  return (
    /^https?:\/\//i.test(val) ||
    /(instagram\.com|instagr\.am|reddit\.com|redd\.it|redgifs\.com)/i.test(val)
  );
}

export function IntakeRail({
  platform,
  mode,
  onModeChange,
  rawInput,
  onRawInputChange,
  subredditLimit,
  onSubredditLimitChange,
  subredditSort,
  onSubredditSortChange,
  zipOptions,
  onZipOptionsChange,
  isExtracting,
  onExtract,
  capabilities,
}: IntakeRailProps) {
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [igSetupOpen, setIgSetupOpen] = useState(false);
  const [copiedEnv, setCopiedEnv] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const maxBatchUrls = capabilities?.maxBatchUrls ?? 25;

  const config = PLATFORM_CONFIG[platform];
  const trimmedInput = rawInput.trim();
  const effectiveLimit =
    platform === 'redgifs' ? Math.min(subredditLimit, 80) : subredditLimit;

  const parsedState = useMemo(() => {
    if (mode === 'single') {
      if (!trimmedInput) {
        return {
          validUrls: [] as string[],
          entries: [],
          duplicateCount: 0,
          truncatedCount: 0,
          singleEntry: null,
        };
      }

      const targetUrl = looksLikeExplicitUrl(trimmedInput)
        ? trimmedInput
        : buildProfileUrl(platform, trimmedInput);

      const entry = classifyUrl(targetUrl);
      return {
        validUrls: entry.valid ? [entry.normalized] : [],
        entries: [entry],
        duplicateCount: 0,
        truncatedCount: 0,
        singleEntry: entry,
      };
    }

    // In bulk mode, convert any bare usernames/shorthand lines using the active platform
    const expandedLines = rawInput
      .split(/\r?\n/)
      .map((line) => {
        const clean = line.trim();
        if (!clean) return '';
        return looksLikeExplicitUrl(clean) ? clean : buildProfileUrl(platform, clean);
      })
      .filter(Boolean)
      .join('\n');

    const bulk = parseBulkUrls(expandedLines, maxBatchUrls);
    const validUrls = bulk.entries
      .filter((e) => e.valid)
      .map((e) => e.normalized);
    return {
      validUrls,
      entries: bulk.entries,
      duplicateCount: bulk.duplicateCount,
      truncatedCount: bulk.truncatedCount,
      singleEntry: null,
    };
  }, [mode, platform, rawInput, trimmedInput, maxBatchUrls]);

  const invalidCount = parsedState.entries.filter((e) => !e.valid).length;
  const sortDisplay =
    subredditSort === 'new'
      ? 'Latest'
      : subredditSort === 'top'
        ? 'Top'
        : 'Hot';

  async function handlePasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) return;
      if (text.includes('\n')) {
        onModeChange('bulk');
        onRawInputChange(
          rawInput.trim() ? `${rawInput.trim()}\n${text.trim()}` : text.trim(),
        );
      } else {
        onRawInputChange(text.trim());
      }
    } catch {
      // Clipboard unavailable in sandboxed iframe
    }
  }

  function handleFileImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const content = typeof reader.result === 'string' ? reader.result : '';
      if (!content.trim()) return;
      onModeChange('bulk');
      onRawInputChange(
        rawInput.trim() ? `${rawInput.trim()}\n${content.trim()}` : content.trim(),
      );
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  async function handleCopyEnv() {
    try {
      await navigator.clipboard.writeText(IG_ENV_SNIPPET);
      setCopiedEnv(true);
      setTimeout(() => setCopiedEnv(false), 1800);
    } catch {
      // ignore
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (parsedState.validUrls.length === 0 || isExtracting) return;
    onExtract(parsedState.validUrls);
  }

  return (
    <section
      aria-label={`${platform} media intake`}
      className="bg-white dark:bg-[#111114] border border-[#E4E4E7] dark:border-[#27272A] rounded-xl p-4 sm:p-5"
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        {mode === 'single' ? (
          <div className="flex flex-col sm:flex-row gap-2.5">
            <div className="relative flex-1 flex items-center">
              <input
                id="platform-url-input"
                type="text"
                value={rawInput}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val.includes('\n')) {
                    onModeChange('bulk');
                  }
                  onRawInputChange(val);
                }}
                placeholder={config.placeholder}
                aria-label={`${platform} username or URL`}
                className="w-full h-11 pl-4 pr-20 text-sm font-mono bg-[#FAFAFA] dark:bg-[#18181B] border border-[#E4E4E7] dark:border-[#27272A] rounded-lg text-[#09090B] dark:text-[#FAFAFA] placeholder:font-sans placeholder:text-[#A1A1AA] dark:placeholder:text-[#71717A] focus:bg-white dark:focus:bg-[#111114] focus:outline-none focus:border-[#1D4ED8] dark:focus:border-[#3B82F6] focus:ring-2 focus:ring-[#1D4ED8]/15 dark:focus:ring-[#3B82F6]/20 transition-colors"
              />
              <div className="absolute right-2 flex items-center gap-1">
                {rawInput && (
                  <button
                    type="button"
                    onClick={() => onRawInputChange('')}
                    aria-label="Clear input"
                    className="p-1.5 text-[#71717A] dark:text-[#A1A1AA] hover:text-[#09090B] dark:hover:text-[#FAFAFA] rounded-md transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={handlePasteFromClipboard}
                  aria-label="Paste from clipboard"
                  title="Paste"
                  className="p-1.5 text-[#52525B] dark:text-[#A1A1AA] hover:text-[#09090B] dark:hover:text-[#FAFAFA] rounded-md transition-colors"
                >
                  <ClipboardPaste className="w-4 h-4" />
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={parsedState.validUrls.length === 0 || isExtracting}
              className={`h-11 px-6 inline-flex items-center justify-center gap-2 text-sm font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1D4ED8] dark:focus-visible:outline-[#3B82F6] ${
                parsedState.validUrls.length > 0 && !isExtracting
                  ? 'bg-[#1D4ED8] dark:bg-[#2563EB] text-white hover:bg-[#1E40AF] dark:hover:bg-[#3B82F6]'
                  : 'bg-[#F4F4F5] dark:bg-[#18181B] text-[#A1A1AA] dark:text-[#52525B] cursor-not-allowed'
              }`}
            >
              {isExtracting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                  <span>Fetching...</span>
                </>
              ) : (
                <>
                  <ArrowDownToLine className="w-4 h-4" aria-hidden="true" />
                  <span>Fetch</span>
                </>
              )}
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="text-[#52525B] dark:text-[#A1A1AA]">
                One username or URL per line (max {maxBatchUrls})
              </span>
              <div className="flex items-center gap-4">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 font-medium text-[#1D4ED8] dark:text-[#60A5FA] hover:text-[#1E40AF] dark:hover:text-[#93C5FD] transition-colors whitespace-nowrap"
                >
                  <FileUp className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Import .txt</span>
                </button>
                {rawInput && (
                  <button
                    type="button"
                    onClick={() => onRawInputChange('')}
                    className="font-medium text-[#71717A] dark:text-[#A1A1AA] hover:text-[#09090B] dark:hover:text-[#FAFAFA]"
                  >
                    Clear
                  </button>
                )}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.csv,text/plain"
                onChange={handleFileImport}
                className="hidden"
              />
            </div>

            <textarea
              id="bulk-url-input"
              rows={4}
              value={rawInput}
              onChange={(e) => onRawInputChange(e.target.value)}
              placeholder={config.bulkPlaceholder}
              className="w-full p-3 text-xs font-mono leading-relaxed bg-[#FAFAFA] dark:bg-[#18181B] border border-[#E4E4E7] dark:border-[#27272A] rounded-lg text-[#09090B] dark:text-[#FAFAFA] placeholder:text-[#A1A1AA] dark:placeholder:text-[#71717A] focus:bg-white dark:focus:bg-[#111114] focus:outline-none focus:border-[#1D4ED8] dark:focus:border-[#3B82F6] transition-colors resize-y"
            />

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-mono tabular-nums text-[#52525B] dark:text-[#A1A1AA]">
                {parsedState.entries.length > 0 && (
                  <>
                    <span className="text-[#09090B] dark:text-[#FAFAFA] font-medium">
                      {parsedState.validUrls.length} valid
                    </span>
                    {invalidCount > 0 && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="text-[#B91C1C] dark:text-[#F87171]">
                          {invalidCount} invalid
                        </span>
                      </>
                    )}
                    {parsedState.duplicateCount > 0 && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{parsedState.duplicateCount} duplicates skipped</span>
                      </>
                    )}
                  </>
                )}
              </div>

              <button
                type="submit"
                disabled={parsedState.validUrls.length === 0 || isExtracting}
                className={`h-10 px-5 inline-flex items-center justify-center gap-2 text-sm font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                  parsedState.validUrls.length > 0 && !isExtracting
                    ? 'bg-[#1D4ED8] dark:bg-[#2563EB] text-white hover:bg-[#1E40AF] dark:hover:bg-[#3B82F6]'
                    : 'bg-[#F4F4F5] dark:bg-[#18181B] text-[#A1A1AA] dark:text-[#52525B] cursor-not-allowed'
                }`}
              >
                {isExtracting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                    <span>Fetching...</span>
                  </>
                ) : (
                  <>
                    <ArrowDownToLine className="w-4 h-4" aria-hidden="true" />
                    <span>
                      {parsedState.validUrls.length > 1
                        ? `Fetch ${parsedState.validUrls.length}`
                        : 'Fetch'}
                    </span>
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* Inline Validation Hint */}
        {mode === 'single' && parsedState.singleEntry && (
          <p
            className={`text-xs truncate ${
              parsedState.singleEntry.valid
                ? 'text-[#15803D] dark:text-[#4ADE80]'
                : 'text-[#B91C1C] dark:text-[#F87171]'
            }`}
          >
            {parsedState.singleEntry.valid
              ? parsedState.singleEntry.normalized.replace(/^https?:\/\/(www\.)?/, '')
              : parsedState.singleEntry.reason}
          </p>
        )}

        {/* Compact Utility Controls */}
        <div className="pt-2 border-t border-[#F4F4F5] dark:border-[#27272A] flex flex-wrap items-center justify-between gap-x-5 gap-y-2 text-xs">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <button
              type="button"
              onClick={() => onModeChange(mode === 'single' ? 'bulk' : 'single')}
              className="inline-flex items-center gap-1.5 font-medium text-[#52525B] dark:text-[#D4D4D8] hover:text-[#1D4ED8] dark:hover:text-[#60A5FA] transition-colors whitespace-nowrap"
            >
              <Layers className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{mode === 'single' ? 'Bulk list' : 'Single input'}</span>
            </button>

            <button
              type="button"
              onClick={() => setOptionsOpen((prev) => !prev)}
              aria-expanded={optionsOpen}
              className="inline-flex items-center gap-1.5 font-medium text-[#52525B] dark:text-[#D4D4D8] hover:text-[#09090B] dark:hover:text-[#FAFAFA] transition-colors whitespace-nowrap"
            >
              <SlidersHorizontal className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Options</span>
              <span className="font-mono text-[#71717A] dark:text-[#A1A1AA] font-normal">
                ({effectiveLimit}/page
                {config.supportsSort ? ` · ${sortDisplay}` : ''})
              </span>
              <ChevronDown
                className={`w-3.5 h-3.5 transition-transform ${
                  optionsOpen ? 'rotate-180' : ''
                }`}
                aria-hidden="true"
              />
            </button>

            {platform === 'instagram' && (
              <button
                type="button"
                onClick={() => setIgSetupOpen((prev) => !prev)}
                aria-expanded={igSetupOpen}
                className="inline-flex items-center gap-1.5 font-medium text-[#52525B] dark:text-[#D4D4D8] hover:text-[#09090B] dark:hover:text-[#FAFAFA] transition-colors whitespace-nowrap"
              >
                <KeyRound className="w-3.5 h-3.5" aria-hidden="true" />
                <span>
                  {capabilities?.instagramSessionConfigured ||
                  capabilities?.instagramRapidApiConfigured
                    ? 'Session active'
                    : 'Session setup'}
                </span>
              </button>
            )}
          </div>

          {config.examples.length > 0 && (
            <div className="flex items-center gap-2 text-[#71717A] dark:text-[#A1A1AA]">
              <span>Try:</span>
              {config.examples.map((ex, idx) => (
                <span key={ex.label} className="inline-flex items-center gap-2">
                  {idx > 0 && <span aria-hidden="true">·</span>}
                  <button
                    type="button"
                    onClick={() => {
                      onModeChange('single');
                      onRawInputChange(ex.input);
                    }}
                    className="font-mono text-[#52525B] dark:text-[#D4D4D8] hover:text-[#1D4ED8] dark:hover:text-[#60A5FA] underline underline-offset-2 decoration-[#D4D4D8] dark:decoration-[#3F3F46] transition-colors whitespace-nowrap"
                  >
                    {ex.label}
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Collapsible Options Drawer */}
        {optionsOpen && (
          <div className="pt-3 border-t border-[#E4E4E7] dark:border-[#27272A] grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
            <div className="flex flex-col gap-1.5">
              <span className="font-medium text-[#52525B] dark:text-[#A1A1AA]">
                Per page
              </span>
              <div className="inline-flex items-center self-start p-0.5 bg-[#F4F4F5] dark:bg-[#18181B] rounded-md">
                {config.limits.map((count) => (
                  <button
                    key={count}
                    type="button"
                    onClick={() => onSubredditLimitChange(count)}
                    className={`px-2.5 py-1 font-mono tabular-nums rounded-xs transition-colors ${
                      effectiveLimit === count
                        ? 'bg-white dark:bg-[#27272A] text-[#09090B] dark:text-[#FAFAFA] shadow-xs font-medium'
                        : 'text-[#52525B] dark:text-[#A1A1AA] hover:text-[#09090B] dark:hover:text-[#FAFAFA]'
                    }`}
                  >
                    {count}
                  </button>
                ))}
              </div>
            </div>

            {config.supportsSort && (
              <div className="flex flex-col gap-1.5">
                <span className="font-medium text-[#52525B] dark:text-[#A1A1AA]">
                  Sort
                </span>
                <div className="inline-flex items-center self-start p-0.5 bg-[#F4F4F5] dark:bg-[#18181B] rounded-md">
                  {(
                    [
                      ['new', 'Latest'],
                      ['top', 'Top'],
                      ['hot', 'Hot'],
                    ] as const
                  ).map(([sortKey, sortLabel]) => (
                    <button
                      key={sortKey}
                      type="button"
                      onClick={() => onSubredditSortChange(sortKey)}
                      className={`px-2.5 py-1 rounded-xs transition-colors ${
                        subredditSort === sortKey
                          ? 'bg-white dark:bg-[#27272A] text-[#09090B] dark:text-[#FAFAFA] shadow-xs font-medium'
                          : 'text-[#52525B] dark:text-[#A1A1AA] hover:text-[#09090B] dark:hover:text-[#FAFAFA]'
                      }`}
                    >
                      {sortLabel}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <span className="font-medium text-[#52525B] dark:text-[#A1A1AA]">
                ZIP format
              </span>
              <label className="inline-flex items-center gap-2 text-[#52525B] dark:text-[#D4D4D8] cursor-pointer">
                <input
                  type="checkbox"
                  checked={zipOptions.organizeByFolder}
                  onChange={(e) =>
                    onZipOptionsChange({
                      ...zipOptions,
                      organizeByFolder: e.target.checked,
                    })
                  }
                  className="w-3.5 h-3.5 rounded-xs border-[#D4D4D8] dark:border-[#3F3F46] accent-[#1D4ED8] dark:accent-[#3B82F6]"
                />
                <span>Group into profile folders</span>
              </label>
              <label className="inline-flex items-center gap-2 text-[#52525B] dark:text-[#D4D4D8] cursor-pointer">
                <input
                  type="checkbox"
                  checked={zipOptions.includeMetadataJson}
                  onChange={(e) =>
                    onZipOptionsChange({
                      ...zipOptions,
                      includeMetadataJson: e.target.checked,
                    })
                  }
                  className="w-3.5 h-3.5 rounded-xs border-[#D4D4D8] dark:border-[#3F3F46] accent-[#1D4ED8] dark:accent-[#3B82F6]"
                />
                <span>Include metadata.json</span>
              </label>
            </div>
          </div>
        )}

        {/* Collapsible Instagram Server Session Setup (Instagram tab only) */}
        {platform === 'instagram' && igSetupOpen && (
          <div className="pt-3 border-t border-[#E4E4E7] dark:border-[#27272A] space-y-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[#52525B] dark:text-[#A1A1AA]">
                Add to server Secrets for Stories, Highlights & high-volume profiles
                {capabilities?.instagramInstaloaderAvailable
                  ? ` · Python Instaloader ${capabilities.instagramInstaloaderVersion || ''} ready`
                  : ''}
              </span>
              <button
                type="button"
                onClick={handleCopyEnv}
                className="inline-flex items-center gap-1 font-medium text-[#1D4ED8] dark:text-[#60A5FA] whitespace-nowrap"
              >
                {copiedEnv ? (
                  <>
                    <Check className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Copy</span>
                  </>
                )}
              </button>
            </div>
            <pre className="p-3 rounded-lg bg-[#FAFAFA] dark:bg-[#18181B] border border-[#E4E4E7] dark:border-[#27272A] font-mono text-[11px] leading-relaxed text-[#09090B] dark:text-[#E4E4E7] overflow-x-auto">
              <code>{IG_ENV_SNIPPET}</code>
            </pre>
          </div>
        )}
      </form>
    </section>
  );
}
