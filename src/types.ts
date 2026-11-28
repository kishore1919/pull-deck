export type Platform = 'instagram' | 'reddit' | 'redgifs';

export type ContentType =
  | 'ig_profile'
  | 'ig_post'
  | 'ig_reel'
  | 'ig_story'
  | 'ig_highlight'
  | 'reddit_post'
  | 'reddit_subreddit'
  | 'reddit_user'
  | 'redgifs_clip'
  | 'redgifs_profile'
  | 'unknown';

export type MediaType = 'image' | 'video';

export type JobStatus =
  | 'queued'
  | 'extracting'
  | 'ready'
  | 'auth_required'
  | 'error';

export interface ParsedUrlEntry {
  raw: string;
  normalized: string;
  platform: Platform | null;
  contentType: ContentType;
  label: string;
  valid: boolean;
  reason?: string;
}

export type DuplicateMatchReason = 'exact' | 'visual' | 'title';

export interface DuplicateAnnotation {
  isDuplicate: boolean;
  canonicalId: string;
  repeatCount: number;
  matchReason?: DuplicateMatchReason;
}

export interface MediaItem {
  id: string;
  jobId: string;
  platform: Platform;
  contentType: ContentType;
  mediaType: MediaType;
  title: string;
  author: string;
  sourceContainer: string; // e.g., r/architecture, @username, or redgifs/@user
  sourceUrl: string;
  mediaUrl: string;
  thumbnailUrl: string;
  filename: string;
  extension: string;
  width?: number;
  height?: number;
  durationSec?: number;
  indexInGroup: number;
  groupSize: number;
  createdAt?: string;
  hasAudioTrack?: boolean;
  postId?: string;
  crosspostRootId?: string;
  canonicalMediaKey?: string;
}

export interface ExtractionJob {
  id: string;
  sourceUrl: string;
  platform: Platform | null;
  contentType: ContentType;
  contentLabel: string;
  status: JobStatus;
  message: string;
  itemCount: number;
  totalAvailable?: number;
  resolverUsed?: string;
  authHint?: string;
  hasMore?: boolean;
  nextCursor?: string;
  pageNumber?: number;
}

export interface BatchExtractRequest {
  urls: string[];
  subredditLimit?: number;
  subredditSort?: 'hot' | 'top' | 'new';
  cursor?: string;
  pageNumber?: number;
}

export interface BatchExtractResponse {
  jobs: ExtractionJob[];
  items: MediaItem[];
  processedAt: string;
}

export interface ZipOptions {
  organizeByFolder: boolean;
  includeMetadataJson: boolean;
}

export interface ZipDownloadItem {
  id: string;
  platform: Platform;
  sourceContainer: string;
  author: string;
  title: string;
  mediaUrl: string;
  sourceUrl: string;
  filename: string;
  mediaType: MediaType;
}

export interface ZipDownloadRequest {
  items: ZipDownloadItem[];
  options: ZipOptions;
  partLabel?: string;
}

export interface ZipPartDownloadItem {
  partNumber: number;
  totalParts: number;
  fileCount: number;
  filename: string;
  status: 'pending' | 'building' | 'downloaded' | 'error';
  blobUrl?: string;
  sizeBytes?: number;
  error?: string;
  items: MediaItem[];
}

export interface CapabilitiesResponse {
  redditPublic: boolean;
  redgifsPublic: boolean;
  instagramPublic: boolean;
  instagramInstaloaderAvailable: boolean;
  instagramInstaloaderVersion?: string | null;
  maxBatchUrls: number;
  maxZipItems: number;
  maxZipVideoItems: number;
  maxProfileLimit: number;
}
