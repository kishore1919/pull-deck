#!/usr/bin/env python3
"""
Stateless, zero-login, zero-variable Python Instaloader worker for PullDeck.

Architecture:
  - Runs strictly in memory (zero cookies, zero login, zero disk writes).
  - Single Post / Carousel / Reel — 4-Layer Instaloader Cascade:
      L1: Instaloader Post.from_shortcode (modern doc_id GraphQL)
      L2: Instaloader session SSR page-data JSON tree walk (<script type="application/json">)
      L3: Instaloader session public embed parser (/p/{shortcode}/embed/captioned/)
      L4: Public OpenGraph metadata fallback (og:video / og:image)
  - Public Profile (@username) — Multi-Layer Instaloader Cascade (No N+1 Storm):
      L1: Instaloader logged-out page data (get_page_data) + direct timeline node
          serialization (zero N+1 Post.from_shortcode calls on single images) +
          doc_id="28904005159232689" cursor pagination (ig_polaris:<token>)
      L2: Classic Instaloader Profile.from_username (web_profile_info) +
          FrozenNodeIterator cursor resumption (ig_frozen:<token>)
      L3: Fresh-session retry with jittered backoff + partial-batch preservation
"""

import base64
import html as html_lib
import itertools
import json
import random
import re
import sys
import time
import zlib
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import instaloader
from instaloader import exceptions as ig_exc

USERNAME_RE = re.compile(r"^[a-zA-Z0-9._]{1,30}$")
SHORTCODE_RE = re.compile(r"^[a-zA-Z0-9_-]{4,40}$")
MAX_CURSOR_DECOMPRESSED_BYTES = 128 * 1024
POLARIS_PROFILE_DOC_ID = "28904005159232689"

USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
]
PUBLIC_SSR_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"

REAL_STDOUT = sys.stdout
sys.stdout = sys.stderr


def emit(payload: Dict[str, Any]) -> None:
    REAL_STDOUT.write(json.dumps(payload, ensure_ascii=False))
    REAL_STDOUT.flush()


def iso_from_timestamp(ts: Any) -> Optional[str]:
    if isinstance(ts, (int, float)) and ts > 0:
        try:
            return datetime.fromtimestamp(float(ts), tz=timezone.utc).isoformat().replace("+00:00", "Z")
        except Exception:
            return None
    return None


def decode_escaped_url(raw: str) -> str:
    return (
        html_lib.unescape(raw)
        .replace("\\u0026", "&")
        .replace("\\/", "/")
        .strip()
    )


def clean_caption(text: Any, fallback: str) -> str:
    if not isinstance(text, str):
        return fallback
    cleaned = re.sub(r"\s+", " ", html_lib.unescape(text)).strip()
    return cleaned[:110] if cleaned else fallback


def pick_best_candidate(candidates: Any) -> Tuple[Optional[str], Optional[int], Optional[int]]:
    if not isinstance(candidates, list) or not candidates:
        return None, None, None
    best_url: Optional[str] = None
    best_w: Optional[int] = None
    best_h: Optional[int] = None
    best_area = -1
    for entry in candidates:
        if not isinstance(entry, dict):
            continue
        url = entry.get("url")
        if not isinstance(url, str) or not url.startswith("http"):
            continue
        w = entry.get("width") if isinstance(entry.get("width"), int) else None
        h = entry.get("height") if isinstance(entry.get("height"), int) else None
        area = (w or 0) * (h or 0)
        if best_url is None or area > best_area:
            best_url = url
            best_w = w
            best_h = h
            best_area = area
    return best_url, best_w, best_h


def encode_compressed_json(obj: Any, max_encoded_len: int = 14000) -> Optional[str]:
    try:
        raw = json.dumps(obj, separators=(",", ":")).encode("utf-8")
        compressed = zlib.compress(raw, level=6)
        encoded = base64.urlsafe_b64encode(compressed).decode("ascii")
        return encoded if len(encoded) <= max_encoded_len else None
    except Exception:
        return None


def decode_compressed_json(token: str, max_token_len: int = 16000) -> Optional[Dict[str, Any]]:
    if not token or len(token) > max_token_len:
        return None
    try:
        compressed = base64.urlsafe_b64decode(token.encode("ascii"))
        decomp = zlib.decompressobj()
        raw = decomp.decompress(compressed, MAX_CURSOR_DECOMPRESSED_BYTES + 1)
        if len(raw) > MAX_CURSOR_DECOMPRESSED_BYTES or not decomp.eof:
            return None
        data = json.loads(raw.decode("utf-8"))
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def encode_frozen_iterator(frozen: instaloader.FrozenNodeIterator) -> Optional[str]:
    try:
        return encode_compressed_json(frozen._asdict())
    except Exception:
        return None


def decode_frozen_iterator(token: str) -> Optional[instaloader.FrozenNodeIterator]:
    data = decode_compressed_json(token)
    if not data:
        return None
    try:
        expected_fields = instaloader.FrozenNodeIterator._fields
        kwargs = {field: data.get(field) for field in expected_fields}
        return instaloader.FrozenNodeIterator(**kwargs)
    except Exception:
        return None


def build_loader(user_agent: Optional[str] = None) -> instaloader.Instaloader:
    """Initialize Instaloader in strictly stateless, anonymous, non-sleeping mode."""
    ua = user_agent or random.choice(USER_AGENTS)
    loader = instaloader.Instaloader(
        sleep=False,
        quiet=True,
        user_agent=ua,
        download_pictures=False,
        download_videos=False,
        download_video_thumbnails=False,
        download_geotags=False,
        download_comments=False,
        save_metadata=False,
        compress_json=False,
        max_connection_attempts=1,
        request_timeout=14.0,
        fatal_status_codes=[400, 401, 403, 429],
        iphone_support=False,
    )
    # Apply realistic browser language header on anonymous session
    try:
        session = getattr(loader.context, "_session", None)
        if session is not None:
            session.headers.update({"Accept-Language": "en-US,en;q=0.9"})
    except Exception:
        pass
    return loader


def get_worker_session(loader: instaloader.Instaloader):
    return getattr(loader.context, "_session", None) or getattr(
        loader.context, "_default_http_session", None
    )


def serialize_instaloader_post(
    post: instaloader.Post,
    default_source_url: str,
) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    username = post.owner_username or "instagram"
    shortcode = post.shortcode or "post"
    caption = clean_caption(post.caption, "")
    created_at = post.date_utc.isoformat() + "Z" if getattr(post, "date_utc", None) else None
    post_url = f"https://www.instagram.com/p/{shortcode}/" if shortcode else default_source_url

    if post.typename == "GraphSidecar":
        nodes = list(post.get_sidecar_nodes())
        total = len(nodes)
        for idx, node in enumerate(nodes, start=1):
            is_video = bool(node.is_video and node.video_url)
            media_url = node.video_url if is_video else node.display_url
            thumb_url = node.display_url or media_url
            if not media_url:
                continue
            items.append(
                {
                    "mediaType": "video" if is_video else "image",
                    "mediaUrl": media_url,
                    "thumbnailUrl": thumb_url,
                    "username": username,
                    "title": caption or f"Instagram Carousel ({shortcode})",
                    "shortcodeOrId": shortcode,
                    "sourceUrl": post_url,
                    "index": idx,
                    "total": total,
                    "createdAt": created_at,
                }
            )
        if items:
            return items

    is_video = bool(post.is_video and post.video_url)
    media_url = post.video_url if is_video else post.url
    thumb_url = post.url or media_url
    if media_url:
        duration = getattr(post, "video_duration", None)
        items.append(
            {
                "mediaType": "video" if is_video else "image",
                "mediaUrl": media_url,
                "thumbnailUrl": thumb_url,
                "username": username,
                "title": caption or f"Instagram {'Reel' if is_video else 'Post'} ({shortcode})",
                "shortcodeOrId": shortcode,
                "sourceUrl": post_url,
                "index": 1,
                "total": 1,
                "durationSec": round(duration) if isinstance(duration, (int, float)) else None,
                "createdAt": created_at,
            }
        )
    return items


def serialize_structured_media_node(
    node: Dict[str, Any],
    fallback_username: str,
    fallback_shortcode: str,
    default_source_url: str,
) -> List[Dict[str, Any]]:
    """
    Universal serializer for Instagram Polaris SSR, GraphQL, and embed media nodes:
    handles XIGPolarisImageMedia, XIGPolarisVideoMedia, XIGPolarisCarouselMedia,
    GraphImage, GraphVideo, and GraphSidecar without extra API round-trips.
    """
    user_obj = node.get("user") if isinstance(node.get("user"), dict) else {}
    owner_obj = node.get("owner") if isinstance(node.get("owner"), dict) else {}
    username = (
        user_obj.get("username")
        or owner_obj.get("username")
        or fallback_username
        or "instagram"
    )
    shortcode = (
        node.get("code")
        or node.get("shortcode")
        or fallback_shortcode
        or "post"
    )
    post_url = (
        f"https://www.instagram.com/p/{shortcode}/"
        if shortcode and shortcode != fallback_username
        else default_source_url
    )

    # Caption extraction across Polaris & legacy shapes
    caption_text = ""
    cap_field = node.get("caption")
    if isinstance(cap_field, dict) and isinstance(cap_field.get("text"), str):
        caption_text = cap_field["text"]
    elif isinstance(cap_field, str):
        caption_text = cap_field
    else:
        edge_cap = node.get("edge_media_to_caption")
        if isinstance(edge_cap, dict):
            edges = edge_cap.get("edges")
            if isinstance(edges, list) and edges and isinstance(edges[0], dict):
                n = edges[0].get("node")
                if isinstance(n, dict) and isinstance(n.get("text"), str):
                    caption_text = n["text"]
    title = clean_caption(caption_text, "")

    created_at = iso_from_timestamp(
        node.get("taken_at") or node.get("taken_at_timestamp")
    )

    items: List[Dict[str, Any]] = []

    # 1. Polaris / iPhone carousel_media array
    carousel_media = node.get("carousel_media")
    if isinstance(carousel_media, list) and len(carousel_media) > 0:
        total = len(carousel_media)
        for idx, child in enumerate(carousel_media, start=1):
            if not isinstance(child, dict):
                continue
            vid_url, vid_w, vid_h = pick_best_candidate(child.get("video_versions"))
            img_url, img_w, img_h = pick_best_candidate(
                (child.get("image_versions2") or {}).get("candidates")
                if isinstance(child.get("image_versions2"), dict)
                else None
            )
            if not img_url and isinstance(child.get("display_uri"), str):
                img_url = child["display_uri"]
            if not img_url and isinstance(child.get("display_url"), str):
                img_url = child["display_url"]

            is_video = bool(vid_url or (child.get("is_video") and child.get("video_url")))
            media_url = vid_url or (child.get("video_url") if is_video else None) or img_url
            thumb_url = img_url or media_url
            if not media_url or not str(media_url).startswith("http"):
                continue

            dur = child.get("video_duration")
            items.append(
                {
                    "mediaType": "video" if is_video else "image",
                    "mediaUrl": str(media_url),
                    "thumbnailUrl": str(thumb_url),
                    "username": str(username),
                    "title": title or f"Instagram Carousel ({shortcode})",
                    "shortcodeOrId": str(shortcode),
                    "sourceUrl": post_url,
                    "index": idx,
                    "total": total,
                    "width": vid_w or img_w or child.get("original_width"),
                    "height": vid_h or img_h or child.get("original_height"),
                    "durationSec": round(dur) if isinstance(dur, (int, float)) else None,
                    "createdAt": created_at,
                }
            )
        if items:
            return items

    # 2. Legacy GraphQL edge_sidecar_to_children
    sidecar = node.get("edge_sidecar_to_children")
    sidecar_edges = sidecar.get("edges") if isinstance(sidecar, dict) else None
    if isinstance(sidecar_edges, list) and len(sidecar_edges) > 0:
        total = len(sidecar_edges)
        for idx, edge in enumerate(sidecar_edges, start=1):
            child = edge.get("node") if isinstance(edge, dict) else None
            if not isinstance(child, dict):
                continue
            is_video = bool(child.get("is_video") and child.get("video_url"))
            media_url = child.get("video_url") if is_video else child.get("display_url")
            thumb_url = child.get("display_url") or media_url
            if not media_url or not str(media_url).startswith("http"):
                continue
            dims = child.get("dimensions") if isinstance(child.get("dimensions"), dict) else {}
            dur = child.get("video_duration")
            items.append(
                {
                    "mediaType": "video" if is_video else "image",
                    "mediaUrl": str(media_url),
                    "thumbnailUrl": str(thumb_url),
                    "username": str(username),
                    "title": title or f"Instagram Carousel ({shortcode})",
                    "shortcodeOrId": str(shortcode),
                    "sourceUrl": post_url,
                    "index": idx,
                    "total": total,
                    "width": dims.get("width"),
                    "height": dims.get("height"),
                    "durationSec": round(dur) if isinstance(dur, (int, float)) else None,
                    "createdAt": created_at,
                }
            )
        if items:
            return items

    # 3. Single video or image node
    vid_url, vid_w, vid_h = pick_best_candidate(node.get("video_versions"))
    if not vid_url and isinstance(node.get("video_url"), str) and node["video_url"].startswith("http"):
        vid_url = node["video_url"]

    img_url, img_w, img_h = pick_best_candidate(
        (node.get("image_versions2") or {}).get("candidates")
        if isinstance(node.get("image_versions2"), dict)
        else None
    )
    if not img_url and isinstance(node.get("display_url"), str) and node["display_url"].startswith("http"):
        img_url = node["display_url"]
    if not img_url and isinstance(node.get("display_uri"), str) and node["display_uri"].startswith("http"):
        img_url = node["display_uri"]

    is_video = bool(vid_url)
    media_url = vid_url if is_video else img_url
    thumb_url = img_url or media_url
    if not media_url or not str(media_url).startswith("http"):
        return []

    dims = node.get("dimensions") if isinstance(node.get("dimensions"), dict) else {}
    dur = node.get("video_duration")
    width = vid_w or img_w or node.get("original_width") or dims.get("width")
    height = vid_h or img_h or node.get("original_height") or dims.get("height")

    items.append(
        {
            "mediaType": "video" if is_video else "image",
            "mediaUrl": str(media_url),
            "thumbnailUrl": str(thumb_url),
            "username": str(username),
            "title": title or f"Instagram {'Reel' if is_video else 'Post'} ({shortcode})",
            "shortcodeOrId": str(shortcode),
            "sourceUrl": post_url,
            "index": 1,
            "total": 1,
            "width": width if isinstance(width, int) else None,
            "height": height if isinstance(height, int) else None,
            "durationSec": round(dur) if isinstance(dur, (int, float)) else None,
            "createdAt": created_at,
        }
    )
    return items


def find_media_node_in_json(obj: Any, target_shortcode: str) -> Optional[Dict[str, Any]]:
    """Deep-walk Instagram SSR JSON blocks for the full media object matching target_shortcode."""
    best_fallback: Optional[Dict[str, Any]] = None

    def walk(cur: Any) -> Optional[Dict[str, Any]]:
        nonlocal best_fallback
        if isinstance(cur, dict):
            code = cur.get("code") or cur.get("shortcode")
            has_rich_media = any(
                k in cur
                for k in (
                    "carousel_media",
                    "edge_sidecar_to_children",
                    "video_versions",
                    "video_url",
                    "image_versions2",
                    "display_url",
                )
            )
            if code == target_shortcode and has_rich_media:
                return cur
            if code == target_shortcode and "display_uri" in cur and best_fallback is None:
                best_fallback = cur

            # Check known wrapper fields first for speed
            for priority_key in (
                "shortcode_media",
                "xdt_api__v1__media__shortcode__web_info",
                "xig_polaris_media_by_shortcode",
            ):
                if priority_key in cur:
                    res = walk(cur[priority_key])
                    if res is not None:
                        return res

            for key, val in cur.items():
                if key in (
                    "shortcode_media",
                    "xdt_api__v1__media__shortcode__web_info",
                    "xig_polaris_media_by_shortcode",
                ):
                    continue
                res = walk(val)
                if res is not None:
                    return res
        elif isinstance(cur, list):
            for entry in cur:
                res = walk(entry)
                if res is not None:
                    return res
        return None

    exact = walk(obj)
    return exact if exact is not None else best_fallback


def extract_post_from_ssr_html(
    loader: instaloader.Instaloader,
    shortcode: str,
    source_url: str,
    content_type: str,
) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    """
    Layer 2 & Layer 4: Fetch public post/reel HTML through Instaloader's session,
    deep-walk <script type="application/json"> SSR data-sjs blocks, and fall back
    to OpenGraph tags if needed.
    """
    session = get_worker_session(loader)
    if session is None:
        return [], None

    path_prefix = "reel" if content_type == "ig_reel" else "p"
    candidate_urls = [f"https://www.instagram.com/{path_prefix}/{shortcode}/"]
    if path_prefix != "p":
        candidate_urls.append(f"https://www.instagram.com/p/{shortcode}/")

    og_html: Optional[str] = None

    for url in candidate_urls:
        for ua in (PUBLIC_SSR_UA, random.choice(USER_AGENTS)):
            try:
                resp = session.get(
                    url,
                    headers={
                        "User-Agent": ua,
                        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                        "Accept-Language": "en-US,en;q=0.9",
                    },
                    timeout=12.0,
                    allow_redirects=True,
                )
            except Exception:
                continue

            if resp.status_code != 200 or "/accounts/login" in (resp.url or ""):
                continue

            html_text = resp.text or ""
            if og_html is None and ("og:image" in html_text or "og:video" in html_text):
                og_html = html_text

            script_blocks = re.findall(
                r'<script[^>]*type="application/json"[^>]*>(.*?)</script>',
                html_text,
                re.S,
            )
            for block in script_blocks:
                if shortcode not in block:
                    continue
                try:
                    parsed = json.loads(block)
                except Exception:
                    continue
                media_node = find_media_node_in_json(parsed, shortcode)
                if media_node:
                    items = serialize_structured_media_node(
                        media_node,
                        fallback_username="instagram",
                        fallback_shortcode=shortcode,
                        default_source_url=source_url,
                    )
                    if items:
                        return items, "instaloader_ssr"

    return [], og_html


def extract_post_from_embed(
    loader: instaloader.Instaloader,
    shortcode: str,
    source_url: str,
    content_type: str,
) -> List[Dict[str, Any]]:
    """
    Layer 3: Instaloader session public embed parser (/p/{shortcode}/embed/captioned/).
    Handles contextJSON, gql_data, edge_sidecar_to_children, video_url, and EmbeddedMediaImage.
    """
    session = get_worker_session(loader)
    if session is None:
        return []

    embed_url = f"https://www.instagram.com/p/{shortcode}/embed/captioned/"
    try:
        resp = session.get(
            embed_url,
            headers={
                "User-Agent": random.choice(USER_AGENTS),
                "Accept": "text/html,application/xhtml+xml",
                "Accept-Language": "en-US,en;q=0.9",
            },
            timeout=12.0,
            allow_redirects=True,
        )
    except Exception:
        return []

    if resp.status_code != 200 or "/accounts/login" in (resp.url or ""):
        return []

    html_text = resp.text or ""

    # 3a. Parse escaped contextJSON string
    ctx_match = re.search(r'"contextJSON"\s*:\s*"((?:[^"\\]|\\.)+)"', html_text)
    if ctx_match:
        try:
            raw_json = json.loads('"' + ctx_match.group(1) + '"')
            ctx = json.loads(raw_json)
            node = find_media_node_in_json(ctx, shortcode)
            if node:
                items = serialize_structured_media_node(
                    node,
                    fallback_username="instagram",
                    fallback_shortcode=shortcode,
                    default_source_url=source_url,
                )
                if items:
                    return items
            media_obj = (ctx.get("context") or {}).get("media") if isinstance(ctx, dict) else None
            if isinstance(media_obj, dict):
                items = serialize_structured_media_node(
                    media_obj,
                    fallback_username="instagram",
                    fallback_shortcode=shortcode,
                    default_source_url=source_url,
                )
                if items:
                    return items
        except Exception:
            pass

    # 3b. Parse embedded gql_data shortcode_media
    gql_match = re.search(r'"gql_data"\s*:\s*(\{[\s\S]*?\})\s*,\s*"', html_text)
    if gql_match:
        try:
            parsed_gql = json.loads(gql_match.group(1))
            sm = parsed_gql.get("shortcode_media") if isinstance(parsed_gql, dict) else None
            if isinstance(sm, dict):
                items = serialize_structured_media_node(
                    sm,
                    fallback_username="instagram",
                    fallback_shortcode=shortcode,
                    default_source_url=source_url,
                )
                if items:
                    return items
        except Exception:
            pass

    # 3c. Direct regex fallback inside embed markup
    user_match = re.search(r'class="UsernameText"[^>]*>([^<]+)<', html_text)
    username = html_lib.unescape(user_match.group(1)).strip() if user_match else "instagram"
    video_match = re.search(r'"video_url"\s*:\s*"([^"]+)"', html_text)
    display_match = re.search(r'"display_url"\s*:\s*"([^"]+)"', html_text)
    embed_img_match = re.search(r'class="EmbeddedMediaImage"[^>]*src="([^"]+)"', html_text)

    if video_match:
        vid_url = decode_escaped_url(video_match.group(1))
        thumb_url = (
            decode_escaped_url(display_match.group(1))
            if display_match
            else (decode_escaped_url(embed_img_match.group(1)) if embed_img_match else vid_url)
        )
        if vid_url.startswith("http"):
            return [
                {
                    "mediaType": "video",
                    "mediaUrl": vid_url,
                    "thumbnailUrl": thumb_url,
                    "username": username,
                    "title": f"Instagram {'Reel' if content_type == 'ig_reel' else 'Post'} ({shortcode})",
                    "shortcodeOrId": shortcode,
                    "sourceUrl": source_url,
                    "index": 1,
                    "total": 1,
                }
            ]

    img_raw = (
        embed_img_match.group(1)
        if embed_img_match
        else (display_match.group(1) if display_match else "")
    )
    if img_raw:
        img_url = decode_escaped_url(img_raw)
        if img_url.startswith("http") and "static.cdninstagram.com/rsrc" not in img_url:
            return [
                {
                    "mediaType": "image",
                    "mediaUrl": img_url,
                    "thumbnailUrl": img_url,
                    "username": username,
                    "title": f"Instagram Post ({shortcode})",
                    "shortcodeOrId": shortcode,
                    "sourceUrl": source_url,
                    "index": 1,
                    "total": 1,
                }
            ]

    return []


def extract_post_from_opengraph(
    html_text: Optional[str],
    shortcode: str,
    source_url: str,
    content_type: str,
) -> List[Dict[str, Any]]:
    """Layer 4: Public OpenGraph meta-tag fallback from fetched post HTML."""
    if not html_text:
        return []

    def get_meta(prop: str) -> Optional[str]:
        m = re.search(
            rf'<meta[^>]*property="{re.escape(prop)}"[^>]*content="([^"]+)"',
            html_text,
            re.I,
        ) or re.search(
            rf'<meta[^>]*content="([^"]+)"[^>]*property="{re.escape(prop)}"',
            html_text,
            re.I,
        )
        return decode_escaped_url(m.group(1)) if m else None

    og_video = get_meta("og:video") or get_meta("og:video:secure_url")
    og_image = get_meta("og:image")
    og_title = get_meta("og:title") or ""
    user_match = re.search(r"@([a-zA-Z0-9._]{1,30})", og_title)
    username = user_match.group(1) if user_match else "instagram"
    title = clean_caption(
        og_title,
        f"Instagram {'Reel' if content_type == 'ig_reel' else 'Post'} ({shortcode})",
    )

    if og_video and og_video.startswith("http"):
        return [
            {
                "mediaType": "video",
                "mediaUrl": og_video,
                "thumbnailUrl": og_image if (og_image and og_image.startswith("http")) else og_video,
                "username": username,
                "title": title,
                "shortcodeOrId": shortcode,
                "sourceUrl": source_url,
                "index": 1,
                "total": 1,
            }
        ]

    if (
        og_image
        and og_image.startswith("http")
        and "static.cdninstagram.com/rsrc" not in og_image
    ):
        return [
            {
                "mediaType": "image",
                "mediaUrl": og_image,
                "thumbnailUrl": og_image,
                "username": username,
                "title": title,
                "shortcodeOrId": shortcode,
                "sourceUrl": source_url,
                "index": 1,
                "total": 1,
            }
        ]

    return []


def extract_post(
    loader: instaloader.Instaloader,
    shortcode: str,
    source_url: str,
    content_type: str,
) -> Dict[str, Any]:
    if not SHORTCODE_RE.match(shortcode):
        return {"ok": False, "error": "Invalid Instagram post shortcode."}

    last_error: Optional[str] = None
    rate_limited = False

    # Layer 1: Native Instaloader Post.from_shortcode (modern doc_id GraphQL)
    try:
        post = instaloader.Post.from_shortcode(loader.context, shortcode)
        items = serialize_instaloader_post(post, source_url)
        if items:
            return {
                "ok": True,
                "items": items,
                "hasMore": False,
                "strategyUsed": "instaloader_graphql",
            }
    except ig_exc.QueryReturnedNotFoundException:
        return {"ok": False, "error": "Instagram post or reel was not found."}
    except (ig_exc.TooManyRequestsException, ig_exc.LoginRequiredException) as exc:
        rate_limited = True
        last_error = str(exc)
    except Exception as exc:
        msg = str(exc)
        if any(tok in msg for tok in ("401", "403", "429", "1675004", "Rate limit")):
            rate_limited = True
        last_error = msg

    # Layer 2: Instaloader session SSR page-data JSON tree walk
    ssr_items, og_html_or_strategy = extract_post_from_ssr_html(
        loader, shortcode, source_url, content_type
    )
    if ssr_items:
        return {
            "ok": True,
            "items": ssr_items,
            "hasMore": False,
            "strategyUsed": "instaloader_ssr",
        }

    # Layer 3: Instaloader session public embed parser
    embed_items = extract_post_from_embed(loader, shortcode, source_url, content_type)
    if embed_items:
        return {
            "ok": True,
            "items": embed_items,
            "hasMore": False,
            "strategyUsed": "instaloader_embed",
        }

    # Layer 4: Public OpenGraph fallback
    og_items = extract_post_from_opengraph(
        og_html_or_strategy if og_html_or_strategy != "instaloader_ssr" else None,
        shortcode,
        source_url,
        content_type,
    )
    if og_items:
        return {
            "ok": True,
            "items": og_items,
            "hasMore": False,
            "strategyUsed": "instaloader_opengraph",
        }

    return {
        "ok": False,
        "rateLimited": rate_limited,
        "error": (
            "Instagram rate-limited anonymous access for this post from this server IP."
            if rate_limited
            else (last_error[:180] if last_error else "Could not extract media from this Instagram post.")
        ),
    }


def node_needs_hydration(node: Dict[str, Any]) -> bool:
    """
    Determine if a Polaris timeline node needs per-post hydration.
    Single images with display_uri/image_versions2 need ZERO extra requests!
    Only multi-slide carousels or videos missing direct child/video URLs hydrate.
    """
    media_type = node.get("media_type")
    typename = str(node.get("__typename") or "")
    has_carousel = isinstance(node.get("carousel_media"), list) and len(node["carousel_media"]) > 0
    has_sidecar = isinstance((node.get("edge_sidecar_to_children") or {}).get("edges"), list)
    has_video = bool(
        (isinstance(node.get("video_versions"), list) and len(node["video_versions"]) > 0)
        or node.get("video_url")
    )

    is_carousel = (
        media_type == 8
        or "Carousel" in typename
        or typename == "GraphSidecar"
        or (isinstance(node.get("carousel_media_count"), int) and node["carousel_media_count"] > 1)
    )
    if is_carousel and not (has_carousel or has_sidecar):
        return True

    is_video = media_type == 2 or "Video" in typename or bool(node.get("is_video"))
    if is_video and not has_video:
        return True

    return False


def serialize_polaris_timeline_edges(
    loader: instaloader.Instaloader,
    edges: List[Dict[str, Any]],
    username: str,
    source_url: str,
) -> Tuple[List[Dict[str, Any]], bool]:
    """
    Serializes Polaris timeline nodes directly (avoiding the N+1 GraphQL storm).
    Only hydrates carousel/video nodes lacking direct URLs, with a circuit-breaker
    so rate-limits degrade gracefully to the high-res node preview instead of failing.
    """
    items: List[Dict[str, Any]] = []
    hydration_throttled = False
    hydrated_count = 0
    max_hydrations_per_page = 6

    for edge in edges:
        node = edge.get("node") if isinstance(edge, dict) else None
        if not isinstance(node, dict):
            continue

        shortcode = str(node.get("code") or node.get("shortcode") or "")
        if (
            shortcode
            and node_needs_hydration(node)
            and not hydration_throttled
            and hydrated_count < max_hydrations_per_page
        ):
            if hydrated_count > 0:
                time.sleep(random.uniform(0.18, 0.42))
            hydrated_count += 1
            media_type = node.get("media_type")
            ct = "ig_reel" if media_type == 2 else "ig_post"
            hydrated = extract_post(
                loader,
                shortcode,
                f"https://www.instagram.com/p/{shortcode}/",
                ct,
            )
            if hydrated.get("ok") and hydrated.get("items"):
                items.extend(hydrated["items"])
                continue
            if hydrated.get("rateLimited"):
                hydration_throttled = True

        # Direct serialization from timeline node (zero extra API calls!)
        direct_items = serialize_structured_media_node(
            node,
            fallback_username=username,
            fallback_shortcode=shortcode or username,
            default_source_url=source_url,
        )
        items.extend(direct_items)

    return items, hydration_throttled


def extract_profile_polaris(
    loader: instaloader.Instaloader,
    username: str,
    source_url: str,
    limit: int,
    polaris_token: Optional[str],
) -> Dict[str, Any]:
    """
    Layer 1 Profile Engine: Uses Instaloader 4.16's logged-out page data
    (get_page_data) and Polaris doc_id pagination (28904005159232689) WITHOUT
    calling the aggressively rate-limited web_profile_info endpoint first, and
    WITHOUT firing N+1 Post.from_shortcode calls on every single-image post.
    """
    page_id: Optional[str] = None
    end_cursor: Optional[str] = None
    buffered_edges: List[Dict[str, Any]] = []
    has_next_page = False
    total_posts: Optional[int] = None

    if polaris_token:
        decoded = decode_compressed_json(polaris_token)
        if not decoded or not decoded.get("id"):
            return {"ok": False, "error": "Invalid Instagram pagination cursor."}
        page_id = str(decoded["id"])
        end_cursor = decoded.get("after") or None
        has_next_page = bool(end_cursor)
        if isinstance(decoded.get("total"), int):
            total_posts = decoded["total"]
    else:
        page_blocks = loader.context.get_page_data(f"{username}/")
        if any(
            isinstance(block, dict)
            and (block.get("xig_user_by_username") or {}).get("is_private")
            for block in page_blocks
        ):
            return {
                "ok": False,
                "private": True,
                "error": f"@{username} is a private Instagram account.",
            }

        user_node = next(
            (
                block["xig_user_by_username"]
                for block in page_blocks
                if isinstance(block, dict)
                and isinstance(block.get("xig_user_by_username"), dict)
                and "polaris_ordered_timeline_connection" in block["xig_user_by_username"]
            ),
            None,
        )
        if not isinstance(user_node, dict):
            return {
                "ok": False,
                "error": f"Instagram page for @{username} did not contain public timeline data.",
            }

        page_id = str(user_node.get("id") or "")
        conn = user_node.get("polaris_ordered_timeline_connection") or {}
        if isinstance(conn, dict):
            raw_edges = conn.get("edges")
            if isinstance(raw_edges, list):
                buffered_edges.extend(raw_edges)
            page_info = conn.get("page_info") or {}
            if isinstance(page_info, dict):
                has_next_page = bool(page_info.get("has_next_page"))
                end_cursor = page_info.get("end_cursor") or None
            if isinstance(conn.get("count"), int):
                total_posts = conn["count"]

    collected_edges: List[Dict[str, Any]] = []
    partial = False
    rate_limited = False

    if buffered_edges:
        take = buffered_edges[:limit]
        collected_edges.extend(take)

    # Fetch additional Polaris GraphQL pages only if we haven't reached limit yet
    gql_pages_fetched = 0
    max_gql_pages_per_batch = 4
    while (
        len(collected_edges) < limit
        and has_next_page
        and end_cursor
        and page_id
        and gql_pages_fetched < max_gql_pages_per_batch
    ):
        if gql_pages_fetched > 0:
            time.sleep(random.uniform(0.25, 0.55))
        gql_pages_fetched += 1
        try:
            variables = {
                "id": page_id,
                "after": end_cursor,
                "first": min(12, limit - len(collected_edges)),
                "__relay_internal__pv__PolarisSEOIsCrawlerrelayprovider": False,
            }
            resp = loader.context.doc_id_graphql_query(
                POLARIS_PROFILE_DOC_ID,
                variables,
                referer=f"https://www.instagram.com/{username}/",
                web_api=True,
            )
            if isinstance(resp, dict) and resp.get("errors"):
                rate_limited = True
                if collected_edges:
                    partial = True
                    break
                err_msg = str(resp["errors"][0].get("message") or "Rate limit exceeded")
                return {"ok": False, "rateLimited": True, "error": err_msg}

            conn = (
                ((resp or {}).get("data") or {})
                .get("node", {})
                .get("polaris_ordered_timeline_connection")
            )
            if not isinstance(conn, dict):
                break
            new_edges = conn.get("edges") or []
            if not isinstance(new_edges, list) or not new_edges:
                has_next_page = False
                end_cursor = None
                break
            collected_edges.extend(new_edges)
            page_info = conn.get("page_info") or {}
            has_next_page = bool(page_info.get("has_next_page"))
            end_cursor = page_info.get("end_cursor") or None
        except (ig_exc.TooManyRequestsException, ig_exc.LoginRequiredException, ig_exc.ConnectionException) as exc:
            rate_limited = True
            if collected_edges:
                partial = True
                break
            return {"ok": False, "rateLimited": True, "error": str(exc)[:180]}
        except Exception as exc:
            if collected_edges:
                partial = True
                break
            return {"ok": False, "error": str(exc)[:180]}

    if not collected_edges:
        return {
            "ok": False,
            "rateLimited": rate_limited,
            "error": f"No public posts returned for @{username}.",
        }

    items, _ = serialize_polaris_timeline_edges(loader, collected_edges, username, source_url)
    next_cursor: Optional[str] = None
    if has_next_page and end_cursor and page_id:
        encoded_token = encode_compressed_json(
            {"id": page_id, "after": end_cursor, "total": total_posts}
        )
        if encoded_token:
            next_cursor = f"ig_polaris:{encoded_token}"

    return {
        "ok": len(items) > 0,
        "items": items,
        "hasMore": bool(next_cursor),
        "nextCursor": next_cursor,
        "totalAvailable": total_posts,
        "postsFetched": len(collected_edges),
        "partial": partial,
        "strategyUsed": "instaloader_polaris",
    }


def extract_profile_classic(
    loader: instaloader.Instaloader,
    username: str,
    source_url: str,
    limit: int,
    offset: int,
    frozen_cursor: Optional[str],
) -> Dict[str, Any]:
    """
    Layer 2 Profile Engine: Classic Instaloader Profile.from_username (web_profile_info)
    with FrozenNodeIterator cursor resumption and partial-batch preservation if throttled.
    """
    profile = instaloader.Profile.from_username(loader.context, username)
    if profile.is_private:
        return {
            "ok": False,
            "private": True,
            "error": f"@{username} is a private Instagram account.",
        }

    total_posts = getattr(profile, "mediacount", None)
    posts_iter = profile.get_posts()
    thawed = False

    if frozen_cursor:
        frozen_obj = decode_frozen_iterator(frozen_cursor)
        if frozen_obj is not None:
            try:
                posts_iter.thaw(frozen_obj)
                thawed = True
            except Exception:
                thawed = False

    page_posts: List[instaloader.Post] = []
    partial = False
    iterator = (
        itertools.islice(posts_iter, limit)
        if thawed
        else itertools.islice(posts_iter, offset, offset + limit)
    )

    try:
        for post in iterator:
            page_posts.append(post)
    except (ig_exc.TooManyRequestsException, ig_exc.LoginRequiredException, ig_exc.ConnectionException):
        if not page_posts:
            raise
        partial = True

    has_more = False
    next_cursor: Optional[str] = None
    if len(page_posts) > 0 and (len(page_posts) == limit or partial):
        try:
            frozen_state = posts_iter.freeze()
            encoded = encode_frozen_iterator(frozen_state)
            if encoded:
                rem = frozen_state.remaining_data or {}
                page_info = rem.get("page_info") if isinstance(rem, dict) else None
                edges = rem.get("edges") if isinstance(rem, dict) else None
                if (isinstance(edges, list) and len(edges) > 0) or (
                    isinstance(page_info, dict) and page_info.get("has_next_page")
                ):
                    has_more = True
                    next_cursor = f"ig_frozen:{encoded}"
        except Exception:
            if isinstance(total_posts, int) and (offset + len(page_posts) < total_posts):
                has_more = True
                next_cursor = f"ig_loader:{offset + len(page_posts)}"

    items: List[Dict[str, Any]] = []
    for post in page_posts:
        try:
            items.extend(serialize_instaloader_post(post, source_url))
        except Exception:
            continue

    return {
        "ok": len(items) > 0,
        "items": items,
        "hasMore": bool(has_more and next_cursor),
        "nextCursor": next_cursor,
        "totalAvailable": total_posts if isinstance(total_posts, int) else None,
        "postsFetched": len(page_posts),
        "partial": partial,
        "strategyUsed": "instaloader_classic",
    }


def extract_profile(
    username: str,
    source_url: str,
    limit: int,
    offset: int,
    cursor: Optional[str],
) -> Dict[str, Any]:
    if not USERNAME_RE.match(username):
        return {"ok": False, "error": "Invalid Instagram username format."}

    # Direct continuation for cursor-resumed pages
    if cursor and cursor.startswith("ig_polaris:"):
        token = cursor[11:]
        loader = build_loader()
        return extract_profile_polaris(loader, username, source_url, limit, token)

    if cursor and cursor.startswith("ig_frozen:"):
        token = cursor[10:]
        loader = build_loader()
        return extract_profile_classic(loader, username, source_url, limit, offset, token)

    errors: List[str] = []
    rate_limited = False

    # Layer 1: Instaloader logged-out page data + direct timeline node serialization
    try:
        loader_l1 = build_loader(USER_AGENTS[0])
        res_l1 = extract_profile_polaris(loader_l1, username, source_url, limit, None)
        if res_l1.get("ok") and res_l1.get("items"):
            return res_l1
        if res_l1.get("private"):
            return res_l1
        if res_l1.get("rateLimited"):
            rate_limited = True
        if res_l1.get("error"):
            errors.append(str(res_l1["error"]))
    except ig_exc.QueryReturnedNotFoundException:
        return {"ok": False, "error": f"Instagram profile @{username} was not found."}
    except (ig_exc.LoginRequiredException, ig_exc.TooManyRequestsException) as exc:
        rate_limited = True
        errors.append(str(exc))
    except Exception as exc:
        msg = str(exc)
        if any(code in msg for code in ("401", "403", "429", "login", "Rate limit")):
            rate_limited = True
        errors.append(msg)

    # Layer 2: Classic Instaloader web_profile_info + FrozenNodeIterator (with fresh session)
    try:
        time.sleep(random.uniform(0.2, 0.45))
        loader_l2 = build_loader(USER_AGENTS[1])
        res_l2 = extract_profile_classic(loader_l2, username, source_url, limit, offset, None)
        if res_l2.get("ok") and res_l2.get("items"):
            return res_l2
        if res_l2.get("private"):
            return res_l2
        if res_l2.get("error"):
            errors.append(str(res_l2["error"]))
    except ig_exc.ProfileNotExistsException:
        return {"ok": False, "error": f"Instagram profile @{username} was not found."}
    except ig_exc.PrivateProfileNotFollowedException:
        return {"ok": False, "error": f"@{username} is a private Instagram account."}
    except (ig_exc.LoginRequiredException, ig_exc.TooManyRequestsException) as exc:
        rate_limited = True
        errors.append(str(exc))
    except ig_exc.ConnectionException as exc:
        msg = str(exc)
        if any(code in msg for code in ("401", "403", "429")):
            rate_limited = True
        errors.append(msg)
    except Exception as exc:
        errors.append(str(exc))

    # Layer 3: One final clean-session Polaris retry with distinct User-Agent on transient throttling
    if rate_limited:
        try:
            time.sleep(random.uniform(0.45, 0.85))
            loader_l3 = build_loader(USER_AGENTS[2])
            res_l3 = extract_profile_polaris(loader_l3, username, source_url, limit, None)
            if res_l3.get("ok") and res_l3.get("items"):
                return res_l3
        except Exception:
            pass

    if rate_limited:
        return {
            "ok": False,
            "rateLimited": True,
            "error": (
                f"Instagram blocked anonymous profile access for @{username} from this cloud server IP. "
                "Single public post, carousel, and reel links still work automatically, or run PullDeck locally on a home network for full Instaloader profile access."
            ),
        }

    detail = errors[-1][:180] if errors else f"Could not load public posts for @{username}."
    return {"ok": False, "error": detail}


def main() -> None:
    try:
        raw_input = sys.stdin.read(65536)
        req = json.loads(raw_input) if raw_input.strip() else {}
    except Exception:
        emit({"ok": False, "error": "Invalid JSON payload supplied to Instaloader worker."})
        return

    content_type = str(req.get("contentType") or "")
    source_url = str(req.get("sourceUrl") or "")
    username = str(req.get("username") or "").strip().lstrip("@")
    shortcode = str(req.get("shortcode") or "").strip()
    cursor = str(req.get("cursor") or "").strip() or None

    # Backward compatibility with frozenCursor field
    if not cursor and req.get("frozenCursor"):
        cursor = f"ig_frozen:{str(req.get('frozenCursor')).strip()}"

    try:
        limit = max(1, min(int(req.get("limit") or 30), 100))
    except (TypeError, ValueError):
        limit = 30

    try:
        offset = max(0, min(int(req.get("offset") or 0), 5000))
    except (TypeError, ValueError):
        offset = 0

    try:
        if content_type == "ig_profile" and username:
            result = extract_profile(username, source_url, limit, offset, cursor)
        elif content_type in ("ig_post", "ig_reel") and shortcode:
            loader = build_loader()
            result = extract_post(loader, shortcode, source_url, content_type)
        elif content_type in ("ig_story", "ig_highlight"):
            result = {
                "ok": False,
                "error": "Instagram requires an account login for Stories and Highlights. Public profiles, posts, carousels, and reels work without login.",
            }
        else:
            result = {"ok": False, "error": "Unsupported Instagram workload target."}

        emit(result)
    except ig_exc.LoginRequiredException:
        emit(
            {
                "ok": False,
                "rateLimited": True,
                "error": "Instagram blocked anonymous Instaloader access from this server IP (login wall returned).",
            }
        )
    except ig_exc.PrivateProfileNotFollowedException:
        emit({"ok": False, "error": "This Instagram profile is private."})
    except ig_exc.TooManyRequestsException:
        emit(
            {
                "ok": False,
                "rateLimited": True,
                "error": "Instagram rate-limited anonymous Instaloader requests from this server IP (HTTP 429).",
            }
        )
    except ig_exc.QueryReturnedNotFoundException:
        emit({"ok": False, "error": "Instagram profile or post was not found."})
    except Exception as exc:
        emit({"ok": False, "error": f"Instaloader worker error: {str(exc)[:180]}"})


if __name__ == "__main__":
    main()
