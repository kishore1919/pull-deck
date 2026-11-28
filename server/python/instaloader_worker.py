#!/usr/bin/env python3
"""
Stateless, zero-login, zero-variable Python Instaloader worker for PullDeck.

Architecture:
  - Runs strictly in memory (zero cookies, zero login, zero disk writes).
  - Single Post / Carousel / Reel — 5-Layer Instaloader Cascade:
      L1: Instaloader logged-out Polaris Post Root GraphQL (doc_id 28891146940585796)
      L2: Instaloader Post.from_shortcode (standard GraphQL)
      L3: Instaloader session SSR page-data JSON tree walk (<script type="application/json">)
      L4: Instaloader session public embed parser (/p/{shortcode}/embed/captioned/)
      L5: Public OpenGraph metadata fallback (og:video / og:image)
  - Public Profile (@username) — Multi-Layer Instaloader Cascade (No N+1 Storm):
      L1: Instaloader logged-out Polaris GraphQL (doc_id 29483846714553007 +
          27981003384861049 + 28904005159232689 cursor pagination) with
          get_page_data fallback and budgeted video/carousel hydration
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
POLARIS_PROFILE_POSTS_DOC_ID = "29483846714553007"
POLARIS_PROFILE_ROOT_DOC_ID = "27981003384861049"
POLARIS_USER_INFO_DOC_ID = "27937681195819736"
POLARIS_PROFILE_DOC_ID = "28904005159232689"
POLARIS_POST_ROOT_DOC_ID = "28891146940585796"

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


def sanitize_session_id(raw: Any) -> Optional[str]:
    if not isinstance(raw, str):
        return None
    val = raw.strip()
    if val.lower().startswith("sessionid="):
        val = val[10:].strip()
    if ";" in val:
        val = val.split(";", 1)[0].strip()
    if not val or len(val) > 512 or any(ch in val for ch in ("\r", "\n", "\0", " ")):
        return None
    return val


def build_loader(
    user_agent: Optional[str] = None,
    session_id: Optional[str] = None,
) -> instaloader.Instaloader:
    """Initialize Instaloader in strictly stateless, non-sleeping, memory-only mode."""
    ua = user_agent or random.choice(USER_AGENTS)
    clean_sid = sanitize_session_id(session_id)
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
        iphone_support=bool(clean_sid),
    )
    try:
        session = getattr(loader.context, "_session", None)
        if session is not None:
            session.headers.update({"Accept-Language": "en-US,en;q=0.9"})
            if clean_sid:
                session.headers.update(
                    {
                        "X-IG-App-ID": IG_WEB_APP_ID,
                        "X-Requested-With": "XMLHttpRequest",
                        "Referer": "https://www.instagram.com/",
                    }
                )
                session.cookies.set(
                    "sessionid",
                    clean_sid,
                    domain=".instagram.com",
                    path="/",
                )
                uid_match = re.match(r"^(\d+)(?:%3A|:)", clean_sid, re.I)
                if uid_match:
                    session.cookies.set(
                        "ds_user_id",
                        uid_match.group(1),
                        domain=".instagram.com",
                        path="/",
                    )
    except Exception:
        pass
    return loader


def sync_session_csrf(loader: instaloader.Instaloader) -> None:
    """Ensure X-CSRFToken header matches any csrftoken cookie returned by Instagram."""
    try:
        session = get_worker_session(loader)
        if session is None:
            return
        csrf = session.cookies.get("csrftoken", domain=".instagram.com") or session.cookies.get("csrftoken")
        if csrf:
            session.headers.update({"X-CSRFToken": csrf})
    except Exception:
        pass


def activate_ephemeral_session(
    loader: instaloader.Instaloader,
    session_id: Optional[str],
) -> Optional[str]:
    """Verify and bind an in-memory Instagram sessionid onto Instaloader context (never writes to disk)."""
    clean_sid = sanitize_session_id(session_id)
    if not clean_sid:
        return None

    # Primary: Instaloader native test_login()
    try:
        username = loader.test_login()
        sync_session_csrf(loader)
        if username:
            loader.context.username = str(username)
            return str(username)
    except Exception:
        pass

    # Fallback: Instagram REST v1 current_user endpoint (handles legacy GraphQL hash throttling)
    try:
        session = get_worker_session(loader)
        if session is not None:
            resp = session.get(
                "https://www.instagram.com/api/v1/accounts/current_user/?edit=true",
                headers={
                    "X-IG-App-ID": IG_WEB_APP_ID,
                    "X-Requested-With": "XMLHttpRequest",
                    "Referer": "https://www.instagram.com/",
                },
                timeout=12,
                allow_redirects=False,
            )
            sync_session_csrf(loader)
            if resp.status_code == 200:
                payload = resp.json()
                user_obj = payload.get("user") if isinstance(payload, dict) else None
                uname = user_obj.get("username") if isinstance(user_obj, dict) else None
                if isinstance(uname, str) and uname.strip():
                    loader.context.username = uname.strip()
                    return uname.strip()
    except Exception:
        pass

    return None


def verify_instagram_session(session_id: Optional[str]) -> Dict[str, Any]:
    clean_sid = sanitize_session_id(session_id)
    if not clean_sid:
        return {
            "ok": False,
            "error": "Paste a valid Instagram sessionid cookie value.",
        }
    loader = build_loader(USER_AGENTS[0], session_id=clean_sid)
    username = activate_ephemeral_session(loader, clean_sid)
    if username:
        return {
            "ok": True,
            "username": username,
        }
    return {
        "ok": False,
        "error": (
            "Instagram rejected or expired this sessionid cookie. "
            "Copy a fresh sessionid from an active Instagram browser session."
        ),
    }


def serialize_story_item(
    story_item: instaloader.StoryItem,
    username: str,
    default_source_url: str,
    ig_category: str,
    title_prefix: str,
    index: int,
    total: int,
) -> Optional[Dict[str, Any]]:
    is_video = bool(getattr(story_item, "is_video", False) and getattr(story_item, "video_url", None))
    media_url = story_item.video_url if is_video else getattr(story_item, "url", None)
    thumb_url = getattr(story_item, "url", None) or media_url
    if not media_url or not str(media_url).startswith("http"):
        return None
    media_id = str(getattr(story_item, "mediaid", "") or f"{ig_category}_{index}")
    created_at = (
        story_item.date_utc.isoformat() + "Z"
        if getattr(story_item, "date_utc", None)
        else None
    )
    return {
        "mediaType": "video" if is_video else "image",
        "mediaUrl": str(media_url),
        "thumbnailUrl": str(thumb_url),
        "username": username,
        "title": f"{title_prefix} ({index}/{total})" if total > 1 else title_prefix,
        "shortcodeOrId": f"{ig_category}_{media_id}",
        "sourceUrl": default_source_url,
        "index": index,
        "total": total,
        "createdAt": created_at,
        "igCategory": ig_category,
    }


def serialize_v1_reel_media_items(
    raw_items: List[Dict[str, Any]],
    username: str,
    default_source_url: str,
    ig_category: str,
    title_prefix: str,
    target_story_id: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Serialize items returned by Instagram's authenticated /api/v1/feed/reels_media/ endpoint."""
    filtered_nodes = [n for n in raw_items if isinstance(n, dict)]
    if target_story_id:
        matched = [
            n
            for n in filtered_nodes
            if str(n.get("pk") or n.get("id") or "").split("_")[0] == target_story_id
        ]
        if matched:
            filtered_nodes = matched

    items: List[Dict[str, Any]] = []
    total = len(filtered_nodes)
    for idx, node in enumerate(filtered_nodes, start=1):
        video_versions = node.get("video_versions")
        best_video_url: Optional[str] = None
        if isinstance(video_versions, list) and video_versions:
            best_v = max(
                (v for v in video_versions if isinstance(v, dict) and v.get("url")),
                key=lambda v: (v.get("width") or 0) * (v.get("height") or 0),
                default=None,
            )
            if best_v and isinstance(best_v.get("url"), str):
                best_video_url = best_v["url"]

        image_candidates = (
            (node.get("image_versions2") or {}).get("candidates")
            if isinstance(node.get("image_versions2"), dict)
            else None
        )
        best_image_url: Optional[str] = None
        width: Optional[int] = None
        height: Optional[int] = None
        if isinstance(image_candidates, list) and image_candidates:
            best_img = max(
                (c for c in image_candidates if isinstance(c, dict) and c.get("url")),
                key=lambda c: (c.get("width") or 0) * (c.get("height") or 0),
                default=None,
            )
            if best_img and isinstance(best_img.get("url"), str):
                best_image_url = best_img["url"]
                width = best_img.get("width") if isinstance(best_img.get("width"), int) else None
                height = best_img.get("height") if isinstance(best_img.get("height"), int) else None

        is_video = bool(best_video_url) or node.get("media_type") == 2
        media_url = best_video_url if best_video_url else best_image_url
        thumb_url = best_image_url or media_url
        if not media_url or not media_url.startswith("http"):
            continue

        media_id = str(node.get("pk") or node.get("id") or f"{ig_category}_{idx}").split("_")[0]
        duration = node.get("video_duration")
        items.append(
            {
                "mediaType": "video" if (is_video and best_video_url) else "image",
                "mediaUrl": media_url,
                "thumbnailUrl": thumb_url,
                "username": username,
                "title": f"{title_prefix} ({idx}/{total})" if total > 1 else title_prefix,
                "shortcodeOrId": f"{ig_category}_{media_id}",
                "sourceUrl": default_source_url,
                "index": idx,
                "total": total,
                "width": width,
                "height": height,
                "durationSec": round(duration) if isinstance(duration, (int, float)) else None,
                "createdAt": iso_from_timestamp(node.get("taken_at")),
                "igCategory": ig_category,
            }
        )
    return items


def fetch_v1_reels_media(
    loader: instaloader.Instaloader,
    reel_ids: List[str],
) -> Dict[str, Any]:
    """Fetch authenticated story/highlight reels via Instagram's REST v1 feed/reels_media endpoint."""
    session = get_worker_session(loader)
    if session is None or not reel_ids:
        return {}
    sync_session_csrf(loader)
    params = [("reel_ids", rid) for rid in reel_ids]
    try:
        resp = session.get(
            "https://www.instagram.com/api/v1/feed/reels_media/",
            params=params,
            headers={
                "X-IG-App-ID": IG_WEB_APP_ID,
                "X-Requested-With": "XMLHttpRequest",
                "Referer": "https://www.instagram.com/",
            },
            timeout=14,
        )
        sync_session_csrf(loader)
        if resp.status_code == 200:
            payload = resp.json()
            if isinstance(payload, dict):
                reels = payload.get("reels")
                if isinstance(reels, dict) and reels:
                    return reels
                reels_media = payload.get("reels_media")
                if isinstance(reels_media, list) and reels_media:
                    out: Dict[str, Any] = {}
                    for r in reels_media:
                        if isinstance(r, dict) and r.get("id") is not None:
                            out[str(r["id"])] = r
                    return out
    except Exception:
        pass
    return {}


def fetch_authenticated_stories(
    loader: instaloader.Instaloader,
    profile: instaloader.Profile,
    username: str,
    target_story_id: Optional[str] = None,
) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    story_url = f"https://www.instagram.com/stories/{username}/"
    userid_str = str(profile.userid)

    # Tier 1: Instaloader native get_stories(userids=[profile.userid])
    try:
        for story in loader.get_stories(userids=[profile.userid]):
            raw_nodes = list(story.get_items())
            if target_story_id:
                filtered = [s for s in raw_nodes if str(getattr(s, "mediaid", "")) == target_story_id]
                if filtered:
                    raw_nodes = filtered
            total = len(raw_nodes)
            for idx, s_item in enumerate(raw_nodes, start=1):
                entry = serialize_story_item(
                    s_item,
                    username=username,
                    default_source_url=story_url,
                    ig_category="story",
                    title_prefix=f"@{username} Story",
                    index=idx,
                    total=total,
                )
                if entry:
                    items.append(entry)
    except Exception:
        pass

    if items:
        return items

    # Tier 2: Authenticated REST v1 /api/v1/feed/reels_media/?reel_ids={userid} fallback
    reels = fetch_v1_reels_media(loader, [userid_str])
    reel_obj = reels.get(userid_str) if isinstance(reels, dict) else None
    if isinstance(reel_obj, dict) and isinstance(reel_obj.get("items"), list):
        items = serialize_v1_reel_media_items(
            reel_obj["items"],
            username=username,
            default_source_url=story_url,
            ig_category="story",
            title_prefix=f"@{username} Story",
            target_story_id=target_story_id,
        )
    return items


def fetch_authenticated_highlights(
    loader: instaloader.Instaloader,
    profile: instaloader.Profile,
    username: str,
    max_total_slides: int = 80,
    target_highlight_id: Optional[str] = None,
) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []

    # Tier 1: Instaloader native get_highlights(profile)
    try:
        for highlight in loader.get_highlights(profile):
            hid = str(getattr(highlight, "unique_id", "") or "")
            if target_highlight_id and hid != target_highlight_id:
                continue
            hl_title = clean_caption(getattr(highlight, "title", None), "Highlight")
            hl_url = (
                f"https://www.instagram.com/stories/highlights/{hid}/"
                if hid
                else f"https://www.instagram.com/{username}/"
            )
            try:
                hl_items = list(highlight.get_items())
            except Exception:
                continue
            total = len(hl_items)
            for idx, s_item in enumerate(hl_items, start=1):
                if len(items) >= max_total_slides:
                    return items
                entry = serialize_story_item(
                    s_item,
                    username=username,
                    default_source_url=hl_url,
                    ig_category="highlight",
                    title_prefix=f"Highlight: {hl_title}",
                    index=idx,
                    total=total,
                )
                if entry:
                    items.append(entry)
    except Exception:
        pass

    if items:
        return items

    # Tier 2: Authenticated REST v1 highlights_tray + feed/reels_media fallback
    session = get_worker_session(loader)
    if session is None:
        return items
    try:
        sync_session_csrf(loader)
        tray_resp = session.get(
            f"https://www.instagram.com/api/v1/highlights/{profile.userid}/highlights_tray/",
            headers={
                "X-IG-App-ID": IG_WEB_APP_ID,
                "X-Requested-With": "XMLHttpRequest",
                "Referer": f"https://www.instagram.com/{username}/",
            },
            timeout=14,
        )
        if tray_resp.status_code != 200:
            return items
        tray_data = tray_resp.json()
        tray = tray_data.get("tray") if isinstance(tray_data, dict) else None
        if not isinstance(tray, list) or not tray:
            return items

        reel_meta: List[Tuple[str, str]] = []
        for entry in tray:
            if not isinstance(entry, dict):
                continue
            raw_rid = str(entry.get("id") or "")
            hid = raw_rid.replace("highlight:", "")
            if not hid:
                continue
            if target_highlight_id and hid != target_highlight_id:
                continue
            title = clean_caption(entry.get("title"), "Highlight")
            reel_meta.append((f"highlight:{hid}", title))

        for chunk_start in range(0, min(len(reel_meta), 20), 5):
            chunk = reel_meta[chunk_start : chunk_start + 5]
            reels = fetch_v1_reels_media(loader, [rid for rid, _ in chunk])
            for rid, title in chunk:
                reel_obj = reels.get(rid)
                if not isinstance(reel_obj, dict) or not isinstance(reel_obj.get("items"), list):
                    continue
                hid = rid.replace("highlight:", "")
                hl_url = f"https://www.instagram.com/stories/highlights/{hid}/"
                batch = serialize_v1_reel_media_items(
                    reel_obj["items"],
                    username=username,
                    default_source_url=hl_url,
                    ig_category="highlight",
                    title_prefix=f"Highlight: {title}",
                )
                for b_item in batch:
                    if len(items) >= max_total_slides:
                        return items
                    items.append(b_item)
    except Exception:
        pass
    return items


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
    product_type = str(node.get("product_type") or "").lower()
    is_reel = product_type == "clips"
    ig_category = "reel" if is_reel else ("video" if is_video else "photo")

    items.append(
        {
            "mediaType": "video" if is_video else "image",
            "mediaUrl": str(media_url),
            "thumbnailUrl": str(thumb_url),
            "username": str(username),
            "title": title or f"Instagram {'Reel' if is_reel else ('Video' if is_video else 'Post')} ({shortcode})",
            "shortcodeOrId": str(shortcode),
            "sourceUrl": f"https://www.instagram.com/reel/{shortcode}/" if is_reel and shortcode else post_url,
            "index": 1,
            "total": 1,
            "width": width if isinstance(width, int) else None,
            "height": height if isinstance(height, int) else None,
            "durationSec": round(dur) if isinstance(dur, (int, float)) else None,
            "createdAt": created_at,
            "igCategory": ig_category,
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


def extract_post_from_polaris_graphql(
    loader: instaloader.Instaloader,
    shortcode: str,
    source_url: str,
    media_id: Optional[str] = None,
) -> Tuple[List[Dict[str, Any]], bool]:
    """
    Layer 1: Instaloader logged-out Polaris Post Root GraphQL query
    (PolarisLoggedOutDesktopWWWPostRootContentQuery, web_api=True).
    Returns full progressive MP4 video_versions, full carousel_media slides,
    and full-res image_versions2 anonymously even from cloud datacenter IPs.
    """
    try:
        mid = str(media_id) if media_id else str(instaloader.Post.shortcode_to_mediaid(shortcode))
    except Exception:
        return [], False

    try:
        resp = loader.context.doc_id_graphql_query(
            POLARIS_POST_ROOT_DOC_ID,
            {
                "shortcode": shortcode,
                "media_id": mid,
                "__relay_internal__pv__PolarisSEOIsCrawlerrelayprovider": False,
            },
            referer=f"https://www.instagram.com/p/{shortcode}/",
            web_api=True,
        )
    except (ig_exc.TooManyRequestsException, ig_exc.LoginRequiredException):
        return [], True
    except Exception:
        return [], False

    if not isinstance(resp, dict):
        return [], False

    errors = resp.get("errors")
    if isinstance(errors, list) and errors:
        codes = [e.get("code") for e in errors if isinstance(e, dict)]
        if 1675004 in codes:
            return [], True

    media_root = ((resp.get("data") or {}).get("xig_polaris_media")) or None
    if not isinstance(media_root, dict):
        return [], False

    inner = media_root.get("if_not_gated_logged_out")
    target_node = inner if isinstance(inner, dict) else media_root
    items = serialize_structured_media_node(
        target_node,
        fallback_username="instagram",
        fallback_shortcode=shortcode,
        default_source_url=source_url,
    )
    return items, False


def extract_post(
    loader: instaloader.Instaloader,
    shortcode: str,
    source_url: str,
    content_type: str,
    media_id: Optional[str] = None,
) -> Dict[str, Any]:
    if not SHORTCODE_RE.match(shortcode):
        return {"ok": False, "error": "Invalid Instagram post shortcode."}

    last_error: Optional[str] = None
    rate_limited = False

    # Layer 1: Instaloader logged-out Polaris Post Root GraphQL (full video & carousel slides)
    polaris_items, polaris_rl = extract_post_from_polaris_graphql(
        loader, shortcode, source_url, media_id=media_id
    )
    if polaris_items:
        if content_type == "ig_reel":
            for it in polaris_items:
                if it.get("mediaType") == "video":
                    it["igCategory"] = "reel"
        return {
            "ok": True,
            "items": polaris_items,
            "hasMore": False,
            "strategyUsed": "instaloader_polaris_post",
        }
    if polaris_rl:
        rate_limited = True

    # Layer 2: Native Instaloader Post.from_shortcode (modern doc_id GraphQL)
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

    # Layer 3: Instaloader session SSR page-data JSON tree walk
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


def compact_edge_for_cursor(edge: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Strip bloated fields so leftover page-1 edges fit compactly inside cursor tokens."""
    node = edge.get("node") if isinstance(edge, dict) else None
    if not isinstance(node, dict):
        return None
    cap = node.get("caption")
    cap_text = cap.get("text", "") if isinstance(cap, dict) else (cap if isinstance(cap, str) else "")
    compact_node: Dict[str, Any] = {
        "__typename": node.get("__typename"),
        "pk": node.get("pk"),
        "code": node.get("code") or node.get("shortcode"),
        "media_type": node.get("media_type"),
        "product_type": node.get("product_type"),
        "display_uri": node.get("display_uri") or node.get("display_url"),
    }
    if isinstance(node.get("carousel_media_count"), int):
        compact_node["carousel_media_count"] = node["carousel_media_count"]
    if cap_text:
        compact_node["caption"] = {"text": cap_text[:140]}
    return {"node": compact_node}


def fetch_hd_profile_dp_item(
    loader: instaloader.Instaloader,
    username: str,
    pk: Optional[str],
    fallback_pic_url: Optional[str] = None,
    full_name: Optional[str] = None,
    is_private: bool = False,
) -> Optional[Dict[str, Any]]:
    """
    Fetch full-resolution uncropped HD profile picture (DP) via Instaloader's
    logged-out user-info query (doc_id 27937681195819736). Works on BOTH public
    and private profiles without login or cookies.
    """
    best_url = fallback_pic_url if isinstance(fallback_pic_url, str) and fallback_pic_url.startswith("http") else None
    best_w: Optional[int] = None
    best_h: Optional[int] = None

    if pk:
        try:
            hd_resp = loader.context.doc_id_graphql_query(
                POLARIS_USER_INFO_DOC_ID,
                {
                    "id": str(pk),
                    "render_surface": "PROFILE",
                    "__relay_internal__pv__PolarisCannesGuardianExperienceEnabledrelayprovider": True,
                    "__relay_internal__pv__PolarisCASB976ProfileEnabledrelayprovider": False,
                    "__relay_internal__pv__PolarisRepostsConsumptionEnabledrelayprovider": False,
                    "__relay_internal__pv__PolarisWebSchoolsEnabledrelayprovider": False,
                    "enable_integrity_filters": True,
                },
                referer=f"https://www.instagram.com/{username}/",
                web_api=True,
            )
            hd_user = ((hd_resp or {}).get("data") or {}).get("user") or {}
            if isinstance(hd_user, dict):
                hd_info = hd_user.get("hd_profile_pic_url_info")
                if isinstance(hd_info, dict) and isinstance(hd_info.get("url"), str) and hd_info["url"].startswith("http"):
                    best_url = hd_info["url"]
                    if isinstance(hd_info.get("width"), int):
                        best_w = hd_info["width"]
                    if isinstance(hd_info.get("height"), int):
                        best_h = hd_info["height"]
                elif isinstance(hd_user.get("hd_profile_pic_versions"), list):
                    v_url, v_w, v_h = pick_best_candidate(hd_user["hd_profile_pic_versions"])
                    if v_url:
                        best_url, best_w, best_h = v_url, v_w, v_h
                if not best_url and isinstance(hd_user.get("profile_pic_url"), str) and hd_user["profile_pic_url"].startswith("http"):
                    best_url = hd_user["profile_pic_url"]
        except Exception:
            pass

    if not best_url:
        return None

    display_label = f"{full_name} (@{username})" if full_name and full_name.strip() else f"@{username}"
    privacy_tag = "Private Profile · " if is_private else ""
    return {
        "mediaType": "image",
        "mediaUrl": best_url,
        "thumbnailUrl": best_url,
        "username": username,
        "title": f"{privacy_tag}{display_label} — HD Profile Picture (DP)",
        "shortcodeOrId": "dp_hd",
        "sourceUrl": f"https://www.instagram.com/{username}/",
        "index": 1,
        "total": 1,
        "width": best_w,
        "height": best_h,
        "igCategory": "dp",
    }


def extract_highlight_cover_items(
    root_user: Dict[str, Any],
    username: str,
) -> List[Dict[str, Any]]:
    """
    Extract public Highlight tray covers from lox_highlights_connection.
    (Instagram requires an authenticated login for full highlight slides, while
    highlight tray metadata and cover artwork are available logged-out.)
    """
    conn = root_user.get("lox_highlights_connection")
    edges = conn.get("edges") if isinstance(conn, dict) else None
    if not isinstance(edges, list) or not edges:
        return []

    items: List[Dict[str, Any]] = []
    for idx, edge in enumerate(edges, start=1):
        node = edge.get("node") if isinstance(edge, dict) else None
        if not isinstance(node, dict):
            continue
        hl_id = str(node.get("id") or "").strip()
        cover_url = node.get("cover_media_cropped_thumbnail_url")
        if not isinstance(cover_url, str) or not cover_url.startswith("http"):
            continue
        raw_title = clean_caption(node.get("title"), f"Highlight #{idx}")
        items.append(
            {
                "mediaType": "image",
                "mediaUrl": cover_url,
                "thumbnailUrl": cover_url,
                "username": username,
                "title": f"Highlight · {raw_title}",
                "shortcodeOrId": f"highlight_{hl_id or idx}",
                "sourceUrl": (
                    f"https://www.instagram.com/stories/highlights/{hl_id}/"
                    if hl_id
                    else f"https://www.instagram.com/{username}/"
                ),
                "index": idx,
                "total": 1,
                "igCategory": "highlight",
            }
        )
    return items


def serialize_polaris_timeline_edges(
    loader: instaloader.Instaloader,
    edges: List[Dict[str, Any]],
    username: str,
    source_url: str,
) -> Tuple[List[Dict[str, Any]], bool]:
    """
    Serializes Polaris timeline nodes directly (avoiding the N+1 GraphQL storm).
    Hydrates video/carousel nodes via PolarisLoggedOutDesktopWWWPostRootContentQuery
    with a wall-clock budget and circuit breaker so profiles load fast and reliably.
    """
    items: List[Dict[str, Any]] = []
    hydration_throttled = False
    hydrated_count = 0
    max_hydrations_per_page = 16
    hydration_started_at = time.monotonic()
    max_hydration_seconds = 14.0

    for edge in edges:
        node = edge.get("node") if isinstance(edge, dict) else None
        if not isinstance(node, dict):
            continue

        shortcode = str(node.get("code") or node.get("shortcode") or "")
        media_id = str(node.get("pk")) if node.get("pk") else None
        product_type = str(node.get("product_type") or "").lower()
        is_reel_node = product_type == "clips"
        within_budget = (time.monotonic() - hydration_started_at) < max_hydration_seconds

        if (
            shortcode
            and node_needs_hydration(node)
            and not hydration_throttled
            and hydrated_count < max_hydrations_per_page
            and within_budget
        ):
            if hydrated_count > 0:
                time.sleep(random.uniform(0.05, 0.14))
            hydrated_count += 1
            ct = "ig_reel" if is_reel_node else "ig_post"
            hydrated = extract_post(
                loader,
                shortcode,
                f"https://www.instagram.com/{'reel' if is_reel_node else 'p'}/{shortcode}/",
                ct,
                media_id=media_id,
            )
            if hydrated.get("ok") and hydrated.get("items"):
                if is_reel_node:
                    for hi in hydrated["items"]:
                        if hi.get("mediaType") == "video":
                            hi["igCategory"] = "reel"
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
        if is_reel_node:
            for di in direct_items:
                if not di.get("igCategory"):
                    di["igCategory"] = "reel"
        items.extend(direct_items)

    return items, hydration_throttled


def edge_matches_scope(edge: Dict[str, Any], scope: str) -> bool:
    if scope in ("all", "dp", "highlight", "story"):
        return True
    node = edge.get("node") if isinstance(edge.get("node"), dict) else edge
    if not isinstance(node, dict):
        return True
    product_type = str(node.get("product_type") or "").lower()
    media_type = node.get("media_type")
    typename = str(node.get("__typename") or "").lower()
    is_carousel = (
        media_type == 8
        or "sidecar" in typename
        or bool(node.get("carousel_media"))
        or bool(node.get("carousel_media_count"))
    )
    is_video = bool(node.get("is_video")) or media_type == 2 or product_type == "clips"
    if scope == "reel":
        return product_type == "clips"
    if scope == "video":
        return is_video or is_carousel
    if scope == "photo":
        return (not is_video) or is_carousel
    return True


def item_matches_scope(item: Dict[str, Any], scope: str) -> bool:
    if scope == "all":
        return True
    cat = item.get("igCategory")
    mtype = item.get("mediaType")
    if scope == "dp":
        return cat == "dp"
    if scope == "highlight":
        return cat == "highlight"
    if scope == "story":
        return cat == "story"
    if scope == "reel":
        return cat == "reel"
    if scope == "video":
        return mtype == "video"
    if scope == "photo":
        return mtype == "image" and cat not in ("dp", "highlight", "story")
    return True


def fetch_polaris_profile_initial(
    loader: instaloader.Instaloader,
    username: str,
    scope: str = "all",
) -> Dict[str, Any]:
    """
    Fetch initial profile metadata and public timeline via Instaloader's logged-out
    Polaris GraphQL queries, scoped strictly to what the user chose before fetching.
    """
    referer = f"https://www.instagram.com/{username}/"
    gql_rate_limited = False
    root_user: Optional[Dict[str, Any]] = None
    profile_extras: List[Dict[str, Any]] = []

    # Step 1: Query profile root (27981003384861049) for pk, is_private, HD DP, and Highlights
    try:
        root_resp = loader.context.doc_id_graphql_query(
            POLARIS_PROFILE_ROOT_DOC_ID,
            {
                "username": username,
                "__relay_internal__pv__PolarisSEOIsCrawlerrelayprovider": False,
            },
            referer=referer,
            web_api=True,
        )
        if isinstance(root_resp, dict):
            data_obj = root_resp.get("data")
            if isinstance(data_obj, dict) and "xig_user_by_username" in data_obj:
                if data_obj["xig_user_by_username"] is None:
                    return {
                        "ok": False,
                        "notFound": True,
                        "error": f"Instagram profile @{username} was not found.",
                    }
                if isinstance(data_obj["xig_user_by_username"], dict):
                    root_user = data_obj["xig_user_by_username"]
    except (ig_exc.TooManyRequestsException, ig_exc.LoginRequiredException):
        gql_rate_limited = True
    except Exception:
        pass

    if isinstance(root_user, dict):
        is_private = bool(root_user.get("is_private"))
        pk = str(root_user.get("pk") or "") or None
        full_name = str(root_user.get("full_name") or "").strip() or None

        # Ultra-fast DP-only path (~1s, works on BOTH public and private profiles, zero post queries)
        if scope == "dp":
            dp_item = fetch_hd_profile_dp_item(
                loader,
                username,
                pk=pk,
                fallback_pic_url=root_user.get("profile_pic_url"),
                full_name=full_name,
                is_private=is_private,
            )
            if dp_item:
                return {
                    "ok": True,
                    "private": is_private,
                    "privateDpOnly": True,
                    "items": [dp_item],
                    "hasMore": False,
                    "nextCursor": None,
                    "totalAvailable": 1,
                    "postsFetched": 0,
                    "strategy": "instaloader_polaris_dp_only",
                    "notice": (
                        f"@{username} is a private account — full HD profile picture (DP) is ready to download."
                        if is_private
                        else f"Extracted full HD profile picture (DP) for @{username}."
                    ),
                }
            return {
                "ok": False,
                "private": is_private,
                "error": f"Could not load profile picture (DP) for @{username}.",
            }

        # Ultra-fast Highlights-only path (~1s, zero post queries)
        if scope == "highlight":
            if is_private:
                return {
                    "ok": False,
                    "private": True,
                    "error": (
                        f"@{username} is a private account — Highlights are hidden unless you connect a Session "
                        "that follows them. Switch to DP above to download their HD profile picture."
                    ),
                }
            hl_items = extract_highlight_cover_items(root_user, username)
            if hl_items:
                return {
                    "ok": True,
                    "private": False,
                    "privateDpOnly": True,
                    "items": hl_items,
                    "hasMore": False,
                    "nextCursor": None,
                    "totalAvailable": len(hl_items),
                    "postsFetched": 0,
                    "strategy": "instaloader_polaris_highlights_only",
                    "notice": (
                        f"Extracted {len(hl_items)} Highlight cover {'image' if len(hl_items) == 1 else 'images'} for @{username}. "
                        "Connect Session unlock for all individual slides inside Highlights."
                    ),
                }
            return {
                "ok": False,
                "notFound": True,
                "error": f"No public Highlights found on @{username}.",
            }

        # Private profile when requesting All / Photos / Videos / Reels -> still return HD DP cleanly!
        if is_private:
            dp_item = fetch_hd_profile_dp_item(
                loader,
                username,
                pk=pk,
                fallback_pic_url=root_user.get("profile_pic_url"),
                full_name=full_name,
                is_private=True,
            )
            if dp_item:
                return {
                    "ok": True,
                    "private": True,
                    "privateDpOnly": True,
                    "items": [dp_item],
                    "hasMore": False,
                    "nextCursor": None,
                    "totalAvailable": 1,
                    "postsFetched": 0,
                    "strategy": "instaloader_polaris_private_dp",
                    "notice": (
                        f"@{username} is a private account — posts, reels, highlights, and stories "
                        "are hidden by Instagram, but the full HD profile picture (DP) is ready to download."
                    ),
                }
            return {
                "ok": False,
                "private": True,
                "error": f"@{username} is a private Instagram account and no profile picture was returned.",
            }

        # Only bundle DP + Highlights when scope == "all"
        if scope == "all":
            dp_item = fetch_hd_profile_dp_item(
                loader,
                username,
                pk=pk,
                fallback_pic_url=root_user.get("profile_pic_url"),
                full_name=full_name,
                is_private=False,
            )
            if dp_item:
                profile_extras.append(dp_item)
            profile_extras.extend(extract_highlight_cover_items(root_user, username))

    # Step 2: Logged-out Polaris GraphQL timeline query (works on datacenter & residential IPs!)
    try:
        resp = loader.context.doc_id_graphql_query(
            POLARIS_PROFILE_POSTS_DOC_ID,
            {
                "username": username,
                "__relay_internal__pv__PolarisSEOIsCrawlerrelayprovider": False,
            },
            referer=referer,
            web_api=True,
        )
        if isinstance(resp, dict):
            errors = resp.get("errors")
            if isinstance(errors, list) and errors:
                codes = [e.get("code") for e in errors if isinstance(e, dict)]
                if 1675004 in codes:
                    gql_rate_limited = True

            user_node = ((resp.get("data") or {}).get("xig_user_by_username")) or None
            if isinstance(user_node, dict):
                conn = user_node.get("polaris_ordered_timeline_connection") or {}
                raw_edges = conn.get("edges") if isinstance(conn, dict) else None
                page_info = (conn.get("page_info") or {}) if isinstance(conn, dict) else {}
                total_posts: Optional[int] = conn.get("count") if isinstance(conn.get("count"), int) else None
                if isinstance(root_user, dict) and isinstance(root_user.get("all_media_count"), int):
                    total_posts = root_user["all_media_count"]

                if (isinstance(raw_edges, list) and len(raw_edges) > 0) or profile_extras:
                    return {
                        "ok": True,
                        "pageId": str(user_node.get("id") or (root_user or {}).get("id") or ""),
                        "edges": raw_edges if isinstance(raw_edges, list) else [],
                        "profileExtras": profile_extras,
                        "hasNextPage": bool(page_info.get("has_next_page")),
                        "endCursor": page_info.get("end_cursor") or None,
                        "totalPosts": total_posts,
                        "strategy": "instaloader_polaris_graphql",
                    }
    except (ig_exc.TooManyRequestsException, ig_exc.LoginRequiredException):
        gql_rate_limited = True
    except Exception:
        pass

    # If we at least got HD DP / Highlights from root_user, return them gracefully
    if profile_extras:
        return {
            "ok": True,
            "pageId": str((root_user or {}).get("id") or ""),
            "edges": [],
            "profileExtras": profile_extras,
            "hasNextPage": False,
            "endCursor": None,
            "totalPosts": None,
            "strategy": "instaloader_polaris_graphql",
        }

    # Step 3: Automatic fallback — Instaloader 4.16 logged-out HTML page-data parser
    page_blocks = loader.context.get_page_data(f"{username}/")
    for block in page_blocks:
        u_blk = block.get("xig_user_by_username") if isinstance(block, dict) else None
        if isinstance(u_blk, dict) and u_blk.get("is_private"):
            dp_item = fetch_hd_profile_dp_item(
                loader,
                username,
                pk=str(u_blk.get("pk") or "") or None,
                fallback_pic_url=u_blk.get("profile_pic_url"),
                full_name=str(u_blk.get("full_name") or "").strip() or None,
                is_private=True,
            )
            if dp_item:
                return {
                    "ok": True,
                    "private": True,
                    "privateDpOnly": True,
                    "items": [dp_item],
                    "hasMore": False,
                    "nextCursor": None,
                    "totalAvailable": 1,
                    "postsFetched": 0,
                    "strategy": "instaloader_polaris_private_dp",
                    "notice": (
                        f"@{username} is a private account — posts, reels, highlights, and stories "
                        "are hidden by Instagram, but the full HD profile picture (DP) is ready to download."
                    ),
                }
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
            "rateLimited": gql_rate_limited,
            "error": f"Instagram page for @{username} did not contain public timeline data.",
        }

    conn = user_node.get("polaris_ordered_timeline_connection") or {}
    page_info = (conn.get("page_info") or {}) if isinstance(conn, dict) else {}
    return {
        "ok": True,
        "pageId": str(user_node.get("id") or ""),
        "edges": conn.get("edges") if isinstance(conn.get("edges"), list) else [],
        "profileExtras": [],
        "hasNextPage": bool(page_info.get("has_next_page")),
        "endCursor": page_info.get("end_cursor") or None,
        "totalPosts": conn.get("count") if isinstance(conn.get("count"), int) else None,
        "strategy": "instaloader_polaris_page",
    }


def extract_profile_polaris(
    loader: instaloader.Instaloader,
    username: str,
    source_url: str,
    limit: int,
    polaris_token: Optional[str],
    scope: str = "all",
) -> Dict[str, Any]:
    """
    Layer 1 Profile Engine: Uses Instaloader 4.16's logged-out Polaris GraphQL
    with targeted per-scope fetching (DP, Highlights, Reels, Videos, Photos, All)
    and lossless buffered pagination.
    """
    page_id: Optional[str] = None
    end_cursor: Optional[str] = None
    buffered_edges: List[Dict[str, Any]] = []
    profile_extras: List[Dict[str, Any]] = []
    has_next_page = False
    total_posts: Optional[int] = None
    strategy_used = "instaloader_polaris_graphql"

    if polaris_token:
        decoded = decode_compressed_json(polaris_token)
        if not decoded or not decoded.get("id"):
            return {"ok": False, "error": "Invalid Instagram pagination cursor."}
        page_id = str(decoded["id"])
        end_cursor = decoded.get("after") or None
        has_next_page = bool(decoded.get("hasNext", bool(end_cursor)))
        if isinstance(decoded.get("total"), int):
            total_posts = decoded["total"]
        raw_buf = decoded.get("buf")
        if isinstance(raw_buf, list):
            buffered_edges.extend(e for e in raw_buf if isinstance(e, dict))
    else:
        init = fetch_polaris_profile_initial(loader, username, scope=scope)
        if init.get("privateDpOnly"):
            return init
        if not init.get("ok"):
            return init
        page_id = str(init.get("pageId") or "")
        buffered_edges.extend(init.get("edges") or [])
        profile_extras.extend(init.get("profileExtras") or [])
        has_next_page = bool(init.get("hasNextPage"))
        end_cursor = init.get("endCursor") or None
        total_posts = init.get("totalPosts")
        strategy_used = str(init.get("strategy") or strategy_used)

    collected_edges: List[Dict[str, Any]] = []
    leftover_edges: List[Dict[str, Any]] = []
    partial = False
    rate_limited = False

    if buffered_edges:
        collected_edges.extend(buffered_edges[:limit])
        if len(buffered_edges) > limit:
            leftover_edges = buffered_edges[limit:]

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
            time.sleep(random.uniform(0.18, 0.4))
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
                if collected_edges or profile_extras:
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
            need = limit - len(collected_edges)
            collected_edges.extend(new_edges[:need])
            if len(new_edges) > need:
                leftover_edges.extend(new_edges[need:])
            page_info = conn.get("page_info") or {}
            has_next_page = bool(page_info.get("has_next_page"))
            end_cursor = page_info.get("end_cursor") or None
        except (ig_exc.TooManyRequestsException, ig_exc.LoginRequiredException, ig_exc.ConnectionException) as exc:
            rate_limited = True
            if collected_edges or profile_extras:
                partial = True
                break
            return {"ok": False, "rateLimited": True, "error": str(exc)[:180]}
        except Exception as exc:
            if collected_edges or profile_extras:
                partial = True
                break
            return {"ok": False, "error": str(exc)[:180]}

    if not collected_edges and not profile_extras:
        return {
            "ok": False,
            "rateLimited": rate_limited,
            "error": f"No public posts returned for @{username}.",
        }

    # Pre-filter edges before hydration so we NEVER waste hydration calls on unwanted media types
    scoped_edges = [e for e in collected_edges if edge_matches_scope(e, scope)]
    timeline_items, _ = (
        serialize_polaris_timeline_edges(loader, scoped_edges, username, source_url)
        if scoped_edges
        else ([], False)
    )
    items = [item for item in [*profile_extras, *timeline_items] if item_matches_scope(item, scope)]
    next_cursor: Optional[str] = None
    compact_leftovers = [c for c in (compact_edge_for_cursor(e) for e in leftover_edges) if c is not None]

    if page_id and (compact_leftovers or (has_next_page and end_cursor)):
        cursor_payload: Dict[str, Any] = {
            "id": page_id,
            "after": end_cursor,
            "hasNext": bool(has_next_page and end_cursor),
            "total": total_posts,
        }
        if compact_leftovers:
            cursor_payload["buf"] = compact_leftovers
        encoded_token = encode_compressed_json(cursor_payload)
        if not encoded_token and compact_leftovers:
            cursor_payload.pop("buf", None)
            if has_next_page and end_cursor:
                encoded_token = encode_compressed_json(cursor_payload)
        if encoded_token:
            next_cursor = f"ig_polaris:{encoded_token}"

    if not items:
        scope_names = {
            "photo": "photos",
            "video": "videos",
            "reel": "reels",
            "dp": "profile picture",
            "highlight": "highlights",
            "story": "stories",
        }
        label = scope_names.get(scope, "posts")
        return {
            "ok": False,
            "notFound": True,
            "error": f"No {label} found in this batch for @{username}.",
            "hasMore": bool(next_cursor),
            "nextCursor": next_cursor,
        }

    return {
        "ok": True,
        "items": items,
        "hasMore": bool(next_cursor),
        "nextCursor": next_cursor,
        "totalAvailable": total_posts if (scope == "all" and isinstance(total_posts, int)) else None,
        "postsFetched": len(scoped_edges),
        "partial": partial,
        "strategyUsed": strategy_used,
    }


def extract_profile_classic(
    loader: instaloader.Instaloader,
    username: str,
    source_url: str,
    limit: int,
    offset: int,
    frozen_cursor: Optional[str],
    scope: str = "all",
) -> Dict[str, Any]:
    """
    Layer 2 Profile Engine: Classic Instaloader Profile.from_username (web_profile_info)
    with targeted scope filtering and FrozenNodeIterator cursor resumption.
    """
    profile = instaloader.Profile.from_username(loader.context, username)
    if scope == "dp" or profile.is_private:
        dp_item = fetch_hd_profile_dp_item(
            loader,
            username,
            pk=str(getattr(profile, "userid", "") or "") or None,
            fallback_pic_url=getattr(profile, "profile_pic_url", None),
            full_name=str(getattr(profile, "full_name", "") or "").strip() or None,
            is_private=bool(profile.is_private),
        )
        if dp_item:
            return {
                "ok": True,
                "private": bool(profile.is_private),
                "privateDpOnly": True,
                "items": [dp_item],
                "hasMore": False,
                "nextCursor": None,
                "totalAvailable": 1,
                "postsFetched": 0,
                "strategyUsed": "instaloader_classic_dp",
                "notice": (
                    f"@{username} is a private account — posts, reels, highlights, and stories are hidden by Instagram, "
                    "but the full HD profile picture (DP) is ready to download."
                    if profile.is_private
                    else f"Extracted full HD profile picture (DP) for @{username}."
                ),
            }
        return {
            "ok": False,
            "private": bool(profile.is_private),
            "error": (
                f"@{username} is a private Instagram account."
                if profile.is_private
                else f"Could not load profile picture (DP) for @{username}."
            ),
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
    if scope == "all" and offset == 0 and not frozen_cursor:
        dp_item = fetch_hd_profile_dp_item(
            loader,
            username,
            pk=str(getattr(profile, "userid", "") or "") or None,
            fallback_pic_url=getattr(profile, "profile_pic_url", None),
            full_name=str(getattr(profile, "full_name", "") or "").strip() or None,
            is_private=False,
        )
        if dp_item:
            items.append(dp_item)

    for post in page_posts:
        try:
            for entry in serialize_instaloader_post(post, source_url):
                if item_matches_scope(entry, scope):
                    items.append(entry)
        except Exception:
            continue

    return {
        "ok": len(items) > 0,
        "items": items,
        "hasMore": bool(has_more and next_cursor),
        "nextCursor": next_cursor,
        "totalAvailable": total_posts if (scope == "all" and isinstance(total_posts, int)) else None,
        "postsFetched": len(page_posts),
        "partial": partial,
        "strategyUsed": "instaloader_classic",
    }


def extract_profile_authenticated(
    session_id: str,
    username: str,
    source_url: str,
    limit: int,
    offset: int,
    frozen_cursor: Optional[str],
    scope: str = "all",
) -> Dict[str, Any]:
    """
    Authenticated Instaloader Profile Engine (ephemeral in-memory sessionid).
    Fetches ONLY the requested scope: DP, Stories, Highlights, Reels, Videos, Photos, or All.
    """
    loader = build_loader(USER_AGENTS[0], session_id=session_id)
    viewer = activate_ephemeral_session(loader, session_id)
    if not viewer:
        return {
            "ok": False,
            "sessionInvalid": True,
            "error": (
                "Your connected Instagram session expired or was challenged. "
                "Disconnect or paste a fresh sessionid cookie."
            ),
        }

    profile = instaloader.Profile.from_username(loader.context, username)
    is_own_profile = viewer.lower() == username.lower()
    can_view_private = (not profile.is_private) or bool(getattr(profile, "followed_by_viewer", False)) or is_own_profile

    # Ultra-fast DP-only path
    if scope == "dp":
        dp_item = fetch_hd_profile_dp_item(
            loader,
            username,
            pk=str(getattr(profile, "userid", "") or "") or None,
            fallback_pic_url=getattr(profile, "profile_pic_url", None),
            full_name=str(getattr(profile, "full_name", "") or "").strip() or None,
            is_private=bool(profile.is_private),
        )
        if dp_item:
            return {
                "ok": True,
                "private": bool(profile.is_private and not can_view_private),
                "privateDpOnly": True,
                "items": [dp_item],
                "hasMore": False,
                "nextCursor": None,
                "totalAvailable": 1,
                "postsFetched": 0,
                "strategyUsed": "instaloader_session_dp",
                "notice": f"Extracted full HD profile picture (DP) for @{username}.",
            }
        return {"ok": False, "error": f"Could not load profile picture (DP) for @{username}."}

    if not can_view_private:
        dp_item = fetch_hd_profile_dp_item(
            loader,
            username,
            pk=str(getattr(profile, "userid", "") or "") or None,
            fallback_pic_url=getattr(profile, "profile_pic_url", None),
            full_name=str(getattr(profile, "full_name", "") or "").strip() or None,
            is_private=True,
        )
        if dp_item:
            return {
                "ok": True,
                "private": True,
                "privateDpOnly": True,
                "items": [dp_item],
                "hasMore": False,
                "nextCursor": None,
                "totalAvailable": 1,
                "postsFetched": 0,
                "strategyUsed": "instaloader_session_private_dp",
                "notice": (
                    f"@{username} is private and not followed by @{viewer} — posts, reels, highlights, and stories are hidden, "
                    "but the full HD profile picture (DP) is ready to download."
                ),
            }
        return {
            "ok": False,
            "private": True,
            "error": f"@{username} is a private Instagram account not followed by @{viewer}.",
        }

    # Ultra-fast Stories-only path (skips posts, highlights, DP!)
    if scope == "story":
        story_items = fetch_authenticated_stories(loader, profile, username)
        if story_items:
            return {
                "ok": True,
                "items": story_items,
                "hasMore": False,
                "nextCursor": None,
                "totalAvailable": len(story_items),
                "postsFetched": 0,
                "strategyUsed": "instaloader_session_stories_only",
                "notice": f"Extracted {len(story_items)} active Story {'item' if len(story_items) == 1 else 'items'} for @{username}.",
            }
        return {
            "ok": False,
            "notFound": True,
            "error": f"No active 24-hour Stories found for @{username} right now.",
        }

    # Ultra-fast Highlights-only path (skips posts, stories, DP!)
    if scope == "highlight":
        hl_items = fetch_authenticated_highlights(loader, profile, username, max_total_slides=120)
        if hl_items:
            return {
                "ok": True,
                "items": hl_items,
                "hasMore": False,
                "nextCursor": None,
                "totalAvailable": len(hl_items),
                "postsFetched": 0,
                "strategyUsed": "instaloader_session_highlights_only",
                "notice": f"Extracted {len(hl_items)} Highlight {'slide' if len(hl_items) == 1 else 'slides'} for @{username}.",
            }
        return {
            "ok": False,
            "notFound": True,
            "error": f"No Highlights found on @{username}.",
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
    if scope == "all" and offset == 0 and not frozen_cursor:
        dp_item = fetch_hd_profile_dp_item(
            loader,
            username,
            pk=str(getattr(profile, "userid", "") or "") or None,
            fallback_pic_url=getattr(profile, "profile_pic_url", None),
            full_name=str(getattr(profile, "full_name", "") or "").strip() or None,
            is_private=False,
        )
        if dp_item:
            items.append(dp_item)
        items.extend(fetch_authenticated_stories(loader, profile, username))
        items.extend(fetch_authenticated_highlights(loader, profile, username, max_total_slides=60))

    for post in page_posts:
        try:
            for entry in serialize_instaloader_post(post, source_url):
                if item_matches_scope(entry, scope):
                    items.append(entry)
        except Exception:
            continue

    return {
        "ok": len(items) > 0,
        "items": items,
        "hasMore": bool(has_more and next_cursor),
        "nextCursor": next_cursor,
        "totalAvailable": total_posts if (scope == "all" and isinstance(total_posts, int)) else None,
        "postsFetched": len(page_posts),
        "partial": partial,
        "strategyUsed": "instaloader_session",
    }


def extract_story_or_highlight_authenticated(
    session_id: str,
    content_type: str,
    source_url: str,
    username: Optional[str],
    story_id: Optional[str],
    highlight_id: Optional[str],
) -> Dict[str, Any]:
    loader = build_loader(USER_AGENTS[0], session_id=session_id)
    viewer = activate_ephemeral_session(loader, session_id)
    if not viewer:
        return {
            "ok": False,
            "sessionInvalid": True,
            "error": (
                "Your connected Instagram session expired or was challenged. "
                "Paste a fresh sessionid cookie to fetch Stories and Highlights."
            ),
        }

    if content_type == "ig_story" and username and USERNAME_RE.match(username):
        profile = instaloader.Profile.from_username(loader.context, username)
        items = fetch_authenticated_stories(loader, profile, username, target_story_id=story_id)
        if items:
            return {
                "ok": True,
                "items": items,
                "hasMore": False,
                "nextCursor": None,
                "totalAvailable": len(items),
                "strategyUsed": "instaloader_session_stories",
            }
        return {
            "ok": False,
            "error": f"No active 24-hour Stories found for @{username} right now.",
        }

    if content_type == "ig_highlight" and highlight_id:
        try:
            reel_key = f"highlight:{highlight_id}"
            data = loader.context.graphql_query(
                "45246d3fe16ccc6577e0bd297a5db1ab",
                {
                    "reel_ids": [],
                    "tag_names": [],
                    "location_ids": [],
                    "highlight_reel_ids": [highlight_id],
                    "precomposed_overlay": False,
                },
            )
            reels_media = (data.get("data") or {}).get("reels_media") or []
            if isinstance(reels_media, list) and reels_media:
                reel_node = reels_media[0]
                owner = reel_node.get("owner") or {}
                hl_owner = str(owner.get("username") or username or "instagram")
                hl_title = clean_caption(reel_node.get("title"), f"Highlight {highlight_id}")
                raw_items = reel_node.get("items") or []
                total = len(raw_items)
                items: List[Dict[str, Any]] = []
                for idx, node in enumerate(raw_items, start=1):
                    if not isinstance(node, dict):
                        continue
                    is_video = bool(node.get("is_video"))
                    media_url: Optional[str] = None
                    if is_video:
                        v_res = node.get("video_resources")
                        if isinstance(v_res, list) and v_res:
                            best_v = max(
                                (v for v in v_res if isinstance(v, dict) and v.get("src")),
                                key=lambda v: (v.get("config_width") or 0) * (v.get("config_height") or 0),
                                default=None,
                            )
                            if best_v:
                                media_url = best_v.get("src")
                    disp = node.get("display_url")
                    if not media_url:
                        media_url = disp
                    if not isinstance(media_url, str) or not media_url.startswith("http"):
                        continue
                    items.append(
                        {
                            "mediaType": "video" if is_video and media_url != disp else "image",
                            "mediaUrl": media_url,
                            "thumbnailUrl": disp if isinstance(disp, str) and disp.startswith("http") else media_url,
                            "username": hl_owner,
                            "title": f"Highlight: {hl_title} ({idx}/{total})" if total > 1 else f"Highlight: {hl_title}",
                            "shortcodeOrId": f"highlight_{node.get('id') or idx}",
                            "sourceUrl": source_url,
                            "index": idx,
                            "total": total,
                            "createdAt": iso_from_timestamp(node.get("taken_at_timestamp")),
                            "igCategory": "highlight",
                        }
                    )
                if items:
                    return {
                        "ok": True,
                        "items": items,
                        "hasMore": False,
                        "nextCursor": None,
                        "totalAvailable": len(items),
                        "strategyUsed": "instaloader_session_highlight",
                    }
        except Exception:
            pass

        # Fallback: direct REST v1 /api/v1/feed/reels_media/?reel_ids=highlight:{id}
        try:
            reel_key = f"highlight:{highlight_id}"
            reels = fetch_v1_reels_media(loader, [reel_key])
            reel_obj = reels.get(reel_key)
            if isinstance(reel_obj, dict) and isinstance(reel_obj.get("items"), list):
                owner = reel_obj.get("user") or reel_obj.get("owner") or {}
                hl_owner = str(owner.get("username") or username or "instagram")
                hl_title = clean_caption(reel_obj.get("title"), f"Highlight {highlight_id}")
                v1_items = serialize_v1_reel_media_items(
                    reel_obj["items"],
                    username=hl_owner,
                    default_source_url=source_url,
                    ig_category="highlight",
                    title_prefix=f"Highlight: {hl_title}",
                )
                if v1_items:
                    return {
                        "ok": True,
                        "items": v1_items,
                        "hasMore": False,
                        "nextCursor": None,
                        "totalAvailable": len(v1_items),
                        "strategyUsed": "instaloader_session_highlight_v1",
                    }
        except Exception:
            pass

        return {
            "ok": False,
            "error": (
                f"Could not fetch Highlight {highlight_id} directly. "
                "Paste the user's profile URL instead to pull all their Highlights."
            ),
        }

    return {
        "ok": False,
        "error": "Provide a valid Instagram Story or Highlight URL.",
    }


def extract_profile(
    username: str,
    source_url: str,
    limit: int,
    offset: int,
    cursor: Optional[str],
    session_id: Optional[str] = None,
    scope: str = "all",
) -> Dict[str, Any]:
    if not USERNAME_RE.match(username):
        return {"ok": False, "error": "Invalid Instagram username format."}

    clean_sid = sanitize_session_id(session_id)
    valid_scopes = {"all", "photo", "video", "reel", "dp", "highlight", "story"}
    effective_scope = scope if scope in valid_scopes else "all"

    if effective_scope == "story" and not clean_sid:
        return {
            "ok": False,
            "sessionInvalid": True,
            "error": (
                "Active 24-hour Stories require an Instagram session. "
                "Open Session unlock above to connect a temporary sessionid."
            ),
        }

    # Direct continuation for cursor-resumed pages
    if cursor and cursor.startswith("ig_polaris:"):
        token = cursor[11:]
        loader = build_loader()
        return extract_profile_polaris(loader, username, source_url, limit, token, scope=effective_scope)

    if cursor and cursor.startswith("ig_frozen:"):
        token = cursor[10:]
        if clean_sid:
            return extract_profile_authenticated(clean_sid, username, source_url, limit, offset, token, scope=effective_scope)
        loader = build_loader()
        return extract_profile_classic(loader, username, source_url, limit, offset, token, scope=effective_scope)

    # Optional Ephemeral Session Path (unlocks Stories, full Highlight slides, and followed private profiles)
    if clean_sid:
        try:
            res_auth = extract_profile_authenticated(clean_sid, username, source_url, limit, offset, None, scope=effective_scope)
            if res_auth.get("ok") and res_auth.get("items"):
                return res_auth
            if res_auth.get("private") or res_auth.get("sessionInvalid") or res_auth.get("notFound"):
                return res_auth
        except ig_exc.ProfileNotExistsException:
            return {"ok": False, "error": f"Instagram profile @{username} was not found."}
        except Exception:
            if effective_scope == "story":
                return {
                    "ok": False,
                    "error": f"Could not load active Stories for @{username} using the connected session.",
                }

    errors: List[str] = []
    rate_limited = False

    # Layer 1: Instaloader logged-out Polaris GraphQL (scoped strictly to effective_scope)
    try:
        loader_l1 = build_loader(USER_AGENTS[0])
        res_l1 = extract_profile_polaris(loader_l1, username, source_url, limit, None, scope=effective_scope)
        if res_l1.get("ok") and res_l1.get("items"):
            return res_l1
        if res_l1.get("private") or res_l1.get("notFound"):
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

    # Layer 2: Classic Instaloader web_profile_info + FrozenNodeIterator (skip if highlight-only since classic needs login for highlights)
    if effective_scope != "highlight":
        try:
            time.sleep(random.uniform(0.2, 0.45))
            loader_l2 = build_loader(USER_AGENTS[1])
            res_l2 = extract_profile_classic(loader_l2, username, source_url, limit, offset, None, scope=effective_scope)
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
            res_l3 = extract_profile_polaris(loader_l3, username, source_url, limit, None, scope=effective_scope)
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
                "Single public post, carousel, and reel links still work automatically, or connect a temporary Session."
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

    action = str(req.get("action") or "extract").strip()
    session_id = sanitize_session_id(req.get("sessionId"))

    if action == "verify_session":
        emit(verify_instagram_session(session_id))
        return

    content_type = str(req.get("contentType") or "")
    source_url = str(req.get("sourceUrl") or "")
    username = str(req.get("username") or "").strip().lstrip("@")
    shortcode = str(req.get("shortcode") or "").strip()
    story_id = str(req.get("storyId") or "").strip() or None
    highlight_id = str(req.get("highlightId") or "").strip() or None
    cursor = str(req.get("cursor") or "").strip() or None
    scope = str(req.get("scope") or "all").strip().lower()

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
            result = extract_profile(username, source_url, limit, offset, cursor, session_id=session_id, scope=scope)
        elif content_type in ("ig_post", "ig_reel") and shortcode:
            loader = build_loader(session_id=session_id)
            if session_id:
                activate_ephemeral_session(loader, session_id)
            result = extract_post(loader, shortcode, source_url, content_type)
        elif content_type in ("ig_story", "ig_highlight"):
            if session_id:
                result = extract_story_or_highlight_authenticated(
                    session_id,
                    content_type,
                    source_url,
                    username or None,
                    story_id,
                    highlight_id,
                )
            else:
                result = {
                    "ok": False,
                    "error": (
                        "Instagram requires a session for Stories and full Highlight slides. "
                        "Open Session Unlock above to connect a temporary sessionid, or paste a public profile URL for posts, reels, HD DP, and Highlight covers."
                    ),
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
