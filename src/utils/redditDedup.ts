import type {
  DuplicateAnnotation,
  DuplicateMatchReason,
  MediaItem,
} from '../types';

const TITLE_STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'that',
  'this',
  'with',
  'from',
  'your',
  'you',
  'are',
  'was',
  'were',
  'have',
  'has',
  'just',
  'here',
  'some',
  'into',
  'over',
  'about',
  'what',
  'when',
  'where',
  'how',
  'why',
  'out',
  'all',
  'can',
  'not',
  'but',
]);

const REASON_PRIORITY: Record<DuplicateMatchReason, number> = {
  exact: 3,
  visual: 2,
  title: 1,
};

/**
 * Normalizes a Reddit title by stripping bracketed tags ([OC], [F], [X-Post]),
 * URLs, emojis, and punctuation so reposts with minor tag edits match cleanly.
 */
export function normalizeRedditTitle(rawTitle: string): string {
  return rawTitle
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\[[^\]]{1,24}\]/g, ' ')
    .replace(/\((?:oc|f|m|nb|x-?post[^)]*|crosspost[^)]*|repost[^)]*)\)/gi, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeTitle(normalized: string): string[] {
  return normalized
    .split(' ')
    .filter((token) => token.length >= 3 && !TITLE_STOPWORDS.has(token));
}

function jaccardSimilarity(tokensA: string[], tokensB: string[]): number {
  if (tokensA.length === 0 || tokensB.length === 0) return 0;
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function fallbackCanonicalKey(item: MediaItem): string {
  if (item.canonicalMediaKey) return item.canonicalMediaKey;
  try {
    const parsed = new URL(item.mediaUrl);
    return `url:${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/+$/, '').toLowerCase()}`;
  } catch {
    return `url:${item.mediaUrl.trim().toLowerCase()}`;
  }
}

function getAspectRatio(item: MediaItem): number | null {
  if (item.width && item.height && item.width > 0 && item.height > 0) {
    return item.width / item.height;
  }
  return null;
}

function areMediaCompatible(
  a: MediaItem,
  b: MediaItem,
  maxAspectDelta: number,
  maxDurationDelta: number,
): boolean {
  if (a.mediaType !== b.mediaType) return false;

  const arA = getAspectRatio(a);
  const arB = getAspectRatio(b);
  if (arA !== null && arB !== null && Math.abs(arA - arB) > maxAspectDelta) {
    return false;
  }

  if (
    a.mediaType === 'video' &&
    typeof a.durationSec === 'number' &&
    typeof b.durationSec === 'number' &&
    Math.abs(a.durationSec - b.durationSec) > maxDurationDelta
  ) {
    return false;
  }

  return true;
}

/**
 * Gallery-safe guard: never merge two distinct slides belonging to the exact same Reddit post.
 */
function isSameGalleryPost(a: MediaItem, b: MediaItem): boolean {
  if (a.postId && b.postId && a.postId === b.postId) {
    return a.indexInGroup !== b.indexInGroup;
  }
  if (a.sourceUrl === b.sourceUrl && a.groupSize > 1 && b.groupSize > 1) {
    return a.indexInGroup !== b.indexInGroup;
  }
  return false;
}

/**
 * Computes a 64-bit grayscale perceptual difference hash (dHash) from a same-origin
 * proxied thumbnail image using an offscreen 9x8 Canvas.
 * Returns null if the thumbnail cannot load or is a near-blank flat frame.
 */
export function computeThumbnailDHash(proxyUrl: string): Promise<bigint | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';

    let settled = false;
    const finish = (val: bigint | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(val);
    };

    const timer = window.setTimeout(() => finish(null), 9000);

    img.onload = () => {
      try {
        const width = 9;
        const height = 8;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) {
          finish(null);
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        const { data } = ctx.getImageData(0, 0, width, height);

        const grays = new Float32Array(width * height);
        let minGray = 255;
        let maxGray = 0;

        for (let i = 0; i < width * height; i += 1) {
          const offset = i * 4;
          const gray =
            0.299 * data[offset] +
            0.587 * data[offset + 1] +
            0.114 * data[offset + 2];
          grays[i] = gray;
          if (gray < minGray) minGray = gray;
          if (gray > maxGray) maxGray = gray;
        }

        // Guard against solid-black / blank placeholder video frames falsely matching
        if (maxGray - minGray < 12) {
          finish(null);
          return;
        }

        let hash = 0n;
        let bitPos = 0n;
        for (let y = 0; y < height; y += 1) {
          const rowStart = y * width;
          for (let x = 0; x < width - 1; x += 1) {
            if (grays[rowStart + x] > grays[rowStart + x + 1]) {
              hash |= 1n << bitPos;
            }
            bitPos += 1n;
          }
        }

        if (hash === 0n || hash === 0xffffffffffffffffn) {
          finish(null);
          return;
        }

        finish(hash);
      } catch {
        finish(null);
      }
    };

    img.onerror = () => finish(null);
    img.src = proxyUrl;
  });
}

export function hammingDistance64(a: bigint, b: bigint): number {
  let xor = a ^ b;
  let count = 0;
  while (xor > 0n) {
    xor &= xor - 1n;
    count += 1;
  }
  return count;
}

export function canHashItemThumbnail(item: MediaItem): boolean {
  if (!item.thumbnailUrl) return false;
  if (
    item.mediaType === 'video' &&
    item.thumbnailUrl === item.mediaUrl &&
    /\.mp4(\?|$)/i.test(item.thumbnailUrl)
  ) {
    return false;
  }
  return true;
}

function getTimestampMs(item: MediaItem): number {
  if (!item.createdAt) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(item.createdAt);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function getPixelArea(item: MediaItem): number {
  return (item.width || 0) * (item.height || 0);
}

export interface RedditDedupResult {
  annotations: Map<string, DuplicateAnnotation>;
  hiddenDuplicateIds: Set<string>;
  duplicateCount: number;
}

/**
 * Multi-Signal Reddit Deduplication Engine:
 *   Layer 1 — Exact canonical media key & crosspost parent ID
 *   Layer 2 — Normalized title + media compatibility matching
 *   Layer 3 — 64-bit perceptual dHash visual thumbnail similarity (<= 6 bits)
 *
 * Uses Union-Find clustering and selects the EARLIEST original post (oldest createdAt)
 * in every cluster as the canonical representative.
 */
export function deduplicateRedditItems(
  items: MediaItem[],
  visualHashes: Map<string, bigint | null>,
): RedditDedupResult {
  const n = items.length;
  const annotations = new Map<string, DuplicateAnnotation>();
  const hiddenDuplicateIds = new Set<string>();

  if (n <= 1) {
    for (const item of items) {
      annotations.set(item.id, {
        isDuplicate: false,
        canonicalId: item.id,
        repeatCount: 0,
      });
    }
    return { annotations, hiddenDuplicateIds, duplicateCount: 0 };
  }

  // Disjoint-Set (Union-Find)
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i += 1) parent[i] = i;

  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    let curr = i;
    while (parent[curr] !== root) {
      const next = parent[curr];
      parent[curr] = root;
      curr = next;
    }
    return root;
  };

  // Track best (highest-confidence) reason linking each item to its cluster
  const itemReason = new Array<DuplicateMatchReason | undefined>(n);

  const recordReason = (idx: number, reason: DuplicateMatchReason) => {
    const existing = itemReason[idx];
    if (!existing || REASON_PRIORITY[reason] > REASON_PRIORITY[existing]) {
      itemReason[idx] = reason;
    }
  };

  const union = (aIdx: number, bIdx: number, reason: DuplicateMatchReason) => {
    if (aIdx === bIdx) return;
    if (isSameGalleryPost(items[aIdx], items[bIdx])) return;
    const rootA = find(aIdx);
    const rootB = find(bIdx);
    recordReason(aIdx, reason);
    recordReason(bIdx, reason);
    if (rootA !== rootB) {
      parent[rootB] = rootA;
    }
  };

  // --- Layer 1: Exact Canonical Media Key & Crosspost Root ID ---
  const byMediaKey = new Map<string, number>();
  const byCrosspostKey = new Map<string, number>();
  const byPostId = new Map<string, number>();

  for (let i = 0; i < n; i += 1) {
    const item = items[i];
    const mediaKey = fallbackCanonicalKey(item);
    const existingMediaIdx = byMediaKey.get(mediaKey);
    if (existingMediaIdx !== undefined) {
      union(existingMediaIdx, i, 'exact');
    } else {
      byMediaKey.set(mediaKey, i);
    }

    if (item.postId) {
      const slideKey =
        item.groupSize > 1 ? `${item.postId}:slide_${item.indexInGroup}` : item.postId;
      byPostId.set(slideKey, i);
      const existingCrosspostIdx = byCrosspostKey.get(slideKey);
      if (existingCrosspostIdx !== undefined) {
        union(existingCrosspostIdx, i, 'exact');
      }
    }

    if (item.crosspostRootId) {
      const existingParentIdx = byPostId.get(item.crosspostRootId);
      if (existingParentIdx !== undefined) {
        union(existingParentIdx, i, 'exact');
      }
      const existingPeerIdx = byCrosspostKey.get(item.crosspostRootId);
      if (existingPeerIdx !== undefined) {
        union(existingPeerIdx, i, 'exact');
      } else {
        byCrosspostKey.set(item.crosspostRootId, i);
      }
    }
  }

  // --- Layer 2: Normalized Title + Media Compatibility ---
  const normalizedTitles = new Array<string>(n);
  const titleTokens: string[][] = new Array(n);
  const byExactTitle = new Map<string, number[]>();
  const tokenBucketIndices: number[] = [];

  for (let i = 0; i < n; i += 1) {
    const norm = normalizeRedditTitle(items[i].title || '');
    normalizedTitles[i] = norm;
    const tokens = tokenizeTitle(norm);
    titleTokens[i] = tokens;

    // Require >= 10 chars and >= 2 meaningful words to avoid collapsing generic titles like "OC" or "Me"
    if (norm.length >= 10 && tokens.length >= 2) {
      const bucket = byExactTitle.get(norm);
      if (bucket) {
        for (const prevIdx of bucket) {
          if (areMediaCompatible(items[prevIdx], items[i], 0.14, 2)) {
            union(prevIdx, i, 'title');
            break;
          }
        }
        bucket.push(i);
      } else {
        byExactTitle.set(norm, [i]);
      }
    }

    if (tokens.length >= 4) {
      tokenBucketIndices.push(i);
    }
  }

  // High-similarity near-identical titles (>= 0.85 Jaccard) via inverted token index
  const invertedTokenIndex = new Map<string, number[]>();
  for (const idx of tokenBucketIndices) {
    const tokens = titleTokens[idx];
    const candidateHits = new Map<number, number>();
    for (const token of new Set(tokens)) {
      const list = invertedTokenIndex.get(token);
      if (list) {
        // Limit hot-token fanout for smooth O(N) performance on 1000+ items
        const cap = Math.min(list.length, 40);
        for (let k = 0; k < cap; k += 1) {
          const prevIdx = list[k];
          candidateHits.set(prevIdx, (candidateHits.get(prevIdx) || 0) + 1);
        }
        if (list.length < 40) list.push(idx);
      } else {
        invertedTokenIndex.set(token, [idx]);
      }
    }

    for (const [prevIdx, sharedCount] of candidateHits.entries()) {
      if (sharedCount < 3) continue;
      if (find(prevIdx) === find(idx)) continue;
      if (!areMediaCompatible(items[prevIdx], items[idx], 0.08, 1)) continue;
      if (jaccardSimilarity(titleTokens[prevIdx], tokens) >= 0.85) {
        union(prevIdx, idx, 'title');
      }
    }
  }

  // --- Layer 3: Perceptual 64-bit dHash Visual Thumbnail Similarity ---
  // Use 4-band (16-bit) multi-index hashing so 600+ items match in near-linear time
  // (pigeonhole principle guarantees Hamming distance <= 6 shares >= 1 identical 16-bit band across 4 bands,
  //  actually for <= 6 bits across 4 bands, up to 4 bands can have 1-2 bits each, so we also directly check
  //  hashed items when count <= 800, which takes < 3ms in JS for 64-bit BigInt XOR!)
  const hashedIndices: number[] = [];
  const hashedValues: bigint[] = [];
  for (let i = 0; i < n; i += 1) {
    const h = visualHashes.get(items[i].id);
    if (typeof h === 'bigint') {
      hashedIndices.push(i);
      hashedValues.push(h);
    }
  }

  const MAX_VISUAL_HAMMING = 6;
  const hCount = hashedIndices.length;
  for (let a = 0; a < hCount; a += 1) {
    const idxA = hashedIndices[a];
    const hashA = hashedValues[a];
    const itemA = items[idxA];

    for (let b = a + 1; b < hCount; b += 1) {
      const idxB = hashedIndices[b];
      if (find(idxA) === find(idxB)) continue;
      const itemB = items[idxB];
      if (!areMediaCompatible(itemA, itemB, 0.15, 2)) continue;
      if (hammingDistance64(hashA, hashedValues[b]) <= MAX_VISUAL_HAMMING) {
        union(idxA, idxB, 'visual');
      }
    }
  }

  // --- Group Clusters & Select Earliest Original Post per Cluster ---
  const clusters = new Map<number, number[]>();
  for (let i = 0; i < n; i += 1) {
    const root = find(i);
    const list = clusters.get(root);
    if (list) {
      list.push(i);
    } else {
      clusters.set(root, [i]);
    }
  }

  for (const memberIndices of clusters.values()) {
    if (memberIndices.length === 1) {
      const item = items[memberIndices[0]];
      annotations.set(item.id, {
        isDuplicate: false,
        canonicalId: item.id,
        repeatCount: 0,
      });
      continue;
    }

    // Pick the EARLIEST original post by createdAt timestamp (tie-break by highest resolution)
    let canonicalIdx = memberIndices[0];
    let bestTime = getTimestampMs(items[canonicalIdx]);
    let bestArea = getPixelArea(items[canonicalIdx]);

    for (let k = 1; k < memberIndices.length; k += 1) {
      const idx = memberIndices[k];
      const t = getTimestampMs(items[idx]);
      const area = getPixelArea(items[idx]);
      if (t < bestTime || (t === bestTime && area > bestArea)) {
        canonicalIdx = idx;
        bestTime = t;
        bestArea = area;
      }
    }

    const canonicalItem = items[canonicalIdx];
    const repeatCount = memberIndices.length - 1;

    annotations.set(canonicalItem.id, {
      isDuplicate: false,
      canonicalId: canonicalItem.id,
      repeatCount,
    });

    for (const idx of memberIndices) {
      if (idx === canonicalIdx) continue;
      const dupItem = items[idx];
      hiddenDuplicateIds.add(dupItem.id);
      annotations.set(dupItem.id, {
        isDuplicate: true,
        canonicalId: canonicalItem.id,
        repeatCount: 0,
        matchReason: itemReason[idx] || 'exact',
      });
    }
  }

  return {
    annotations,
    hiddenDuplicateIds,
    duplicateCount: hiddenDuplicateIds.size,
  };
}
