import { Moon, Sun } from 'lucide-react';
import type { Platform } from '../types';

interface TopBarProps {
  activePlatform: Platform;
  onPlatformChange: (platform: Platform) => void;
  countsByPlatform: Record<Platform, number>;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
}

const PLATFORMS: Array<{ key: Platform; label: string }> = [
  { key: 'instagram', label: 'Instagram' },
  { key: 'reddit', label: 'Reddit' },
  { key: 'redgifs', label: 'RedGIFs' },
];

export function TopBar({
  activePlatform,
  onPlatformChange,
  countsByPlatform,
  theme,
  onToggleTheme,
}: TopBarProps) {
  return (
    <header className="sticky top-0 z-30 bg-white/95 dark:bg-[#09090B]/95 backdrop-blur-xs border-b border-[#E4E4E7] dark:border-[#27272A]">
      <div className="max-w-[1200px] mx-auto px-4 sm:px-8 h-16 flex items-center justify-between gap-4 sm:gap-8">
        {/* Zone 1: Wordmark */}
        <span className="font-display text-lg font-bold tracking-tight text-[#09090B] dark:text-[#FAFAFA] whitespace-nowrap shrink-0 select-none">
          PullDeck
        </span>

        {/* Zone 2: Instagram / Reddit / RedGIFs Switcher */}
        <nav
          aria-label="Platform selector"
          role="tablist"
          className="inline-flex items-center p-1 bg-[#F4F4F5] dark:bg-[#18181B] border border-[#E4E4E7] dark:border-[#27272A] rounded-lg"
        >
          {PLATFORMS.map(({ key, label }) => {
            const isActive = activePlatform === key;
            const count = countsByPlatform[key];
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => onPlatformChange(key)}
                className={`px-3.5 sm:px-5 py-1.5 text-sm font-medium rounded-md transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1D4ED8] dark:focus-visible:outline-[#3B82F6] ${
                  isActive
                    ? 'bg-white dark:bg-[#27272A] text-[#09090B] dark:text-[#FAFAFA] shadow-xs'
                    : 'text-[#52525B] dark:text-[#A1A1AA] hover:text-[#09090B] dark:hover:text-[#FAFAFA]'
                }`}
              >
                <span>{label}</span>
                {count > 0 && (
                  <span className="ml-1.5 text-xs font-mono tabular-nums text-[#71717A] dark:text-[#A1A1AA]">
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Zone 3: Theme Switch */}
        <button
          type="button"
          onClick={onToggleTheme}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-[#52525B] dark:text-[#D4D4D8] bg-[#F4F4F5] dark:bg-[#18181B] hover:text-[#09090B] dark:hover:text-[#FAFAFA] border border-[#E4E4E7] dark:border-[#27272A] rounded-lg transition-colors whitespace-nowrap shrink-0"
        >
          {theme === 'dark' ? (
            <>
              <Sun className="w-3.5 h-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">Light</span>
            </>
          ) : (
            <>
              <Moon className="w-3.5 h-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">Dark</span>
            </>
          )}
        </button>
      </div>
    </header>
  );
}
