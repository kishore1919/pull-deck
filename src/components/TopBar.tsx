import { Camera, Film, MessageSquare, Moon, Sun } from 'lucide-react';
import type { Platform } from '../types';
import { PWAInstallButton } from './PWAInstallButton';

interface TopBarProps {
  activePlatform: Platform;
  onPlatformChange: (platform: Platform) => void;
  countsByPlatform: Record<Platform, number>;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
}

const PLATFORMS: Array<{
  key: Platform;
  label: string;
  Icon: typeof Camera;
}> = [
  { key: 'instagram', label: 'Instagram', Icon: Camera },
  { key: 'reddit', label: 'Reddit', Icon: MessageSquare },
  { key: 'redgifs', label: 'RedGIFs', Icon: Film },
];

export function TopBar({
  activePlatform,
  onPlatformChange,
  countsByPlatform,
  theme,
  onToggleTheme,
}: TopBarProps) {
  return (
    <>
      <header className="sticky top-0 z-30 pt-safe bg-white/95 dark:bg-[#09090B]/95 backdrop-blur-md border-b border-[#E4E4E7] dark:border-[#27272A]">
        <div className="max-w-[1200px] mx-auto px-3.5 sm:px-8 h-13 sm:h-16 flex items-center justify-between gap-3 sm:gap-8">
          {/* Zone 1: Wordmark */}
          <span className="font-display text-base sm:text-lg font-bold tracking-tight text-[#09090B] dark:text-[#FAFAFA] whitespace-nowrap shrink-0 select-none">
            PullDeck
          </span>

          {/* Zone 2: Desktop Instagram / Reddit / RedGIFs Switcher */}
          <nav
            aria-label="Platform selector"
            role="tablist"
            className="hidden sm:inline-flex items-center p-1 bg-[#F4F4F5] dark:bg-[#18181B] border border-[#E4E4E7] dark:border-[#27272A] rounded-lg"
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
                  className={`px-3 sm:px-5 py-1.5 text-sm font-medium rounded-md transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1D4ED8] dark:focus-visible:outline-[#3B82F6] ${
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

          {/* Zone 3: Install App + Theme Switch */}
          <div className="flex items-center gap-2 shrink-0">
            <PWAInstallButton />
            <button
              type="button"
              onClick={onToggleTheme}
              aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              className="min-w-[40px] min-h-[40px] sm:min-w-0 sm:min-h-0 inline-flex items-center justify-center gap-1.5 px-2.5 sm:px-3 py-2 text-xs font-medium text-[#52525B] dark:text-[#D4D4D8] bg-[#F4F4F5] dark:bg-[#18181B] hover:text-[#09090B] dark:hover:text-[#FAFAFA] border border-[#E4E4E7] dark:border-[#27272A] rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              {theme === 'dark' ? (
                <>
                  <Sun className="w-4 h-4 sm:w-3.5 sm:h-3.5" aria-hidden="true" />
                  <span className="hidden sm:inline">Light</span>
                </>
              ) : (
                <>
                  <Moon className="w-4 h-4 sm:w-3.5 sm:h-3.5" aria-hidden="true" />
                  <span className="hidden sm:inline">Dark</span>
                </>
              )}
            </button>
          </div>
        </div>
      </header>

      {/* Mobile Thumb-Zone Bottom Platform Switcher */}
      <nav
        aria-label="Mobile platform selector"
        role="tablist"
        className="sm:hidden fixed bottom-0 inset-x-0 z-40 pb-safe bg-white/95 dark:bg-[#09090B]/95 backdrop-blur-md border-t border-[#E4E4E7] dark:border-[#27272A]"
      >
        <div className="grid grid-cols-3 h-14">
          {PLATFORMS.map(({ key, label, Icon }) => {
            const isActive = activePlatform === key;
            const count = countsByPlatform[key];
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => onPlatformChange(key)}
                className={`relative flex flex-col items-center justify-center gap-0.5 transition-colors focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-[#1D4ED8] dark:focus-visible:outline-[#3B82F6] ${
                  isActive
                    ? 'text-[#1D4ED8] dark:text-[#60A5FA]'
                    : 'text-[#71717A] dark:text-[#A1A1AA] active:text-[#09090B] dark:active:text-[#FAFAFA]'
                }`}
              >
                {isActive && (
                  <span
                    aria-hidden="true"
                    className="absolute top-0 inset-x-6 h-0.5 bg-[#1D4ED8] dark:bg-[#3B82F6] rounded-b-xs"
                  />
                )}
                <span className="relative inline-flex items-center justify-center">
                  <Icon className="w-5 h-5" strokeWidth={isActive ? 2.2 : 1.8} aria-hidden="true" />
                  {count > 0 && (
                    <span className="ml-1 text-[10px] font-mono tabular-nums font-semibold">
                      {count > 99 ? '99+' : count}
                    </span>
                  )}
                </span>
                <span className="text-[11px] font-medium tracking-tight leading-none">
                  {label}
                </span>
              </button>
            );
          })}
        </div>
      </nav>
    </>
  );
}
