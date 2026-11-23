#!/usr/bin/env python3
"""
Stateless Instaloader worker for PullDeck Instagram workloads.
Reads a JSON payload from stdin, extracts media metadata/URLs strictly in memory
(zero disk writes), supports native FrozenNodeIterator cursor resumption for
deep pagination (600+ posts), and prints a single JSON result object to stdout.
"""

import base64
import itertools
import json
import os
import re
import sys
import zlib
from typing import Any, Dict, List, Optional

import instaloader
from instaloader import exceptions as ig_exc

USERNAME_RE = re.compile(r"^[a-zA-Z0-9._]{1,30}$")
SHORTCODE_RE = re.compile(r"^[a-zA-Z0-9_-]{4,40}$")
NUMERIC_ID_RE = re.compile(r"^\d{1,30}$")
MAX_FROZEN_DECOMPRESSED_BYTES = 128 * 1024


def emit(payload: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.flush()


def encode_frozen_iterator(frozen: instaloader.FrozenNodeIterator) -> Optional[str]:
    try:
        raw = json.dumps(frozen._asdict(), separators=(",", ":")).encode("utf-8")
        compressed = zlib.compress(raw, level=6)
        encoded = base64.urlsafe_b64encode(compressed).decode("ascii")
        if len(encoded) <= 14000:
            return encoded
        return None
    except Exception:
        return None


def decode_frozen_iterator(token: str) -> Optional[instaloader.FrozenNodeIterator]:
    if not token or len(token) > 16000:
        return None
    try:
        compressed = base64.urlsafe_b64decode(token.encode("ascii"))
        decomp = zlib.decompressobj()
        raw = decomp.decompress(compressed, MAX_FROZEN_DECOMPRESSED_BYTES + 1)
        if len(raw) > MAX_FROZEN_DECOMPRESSED_BYTES or not decomp.eof:
            return None
        data = json.loads(raw.decode("utf-8"))
        if not isinstance(data, dict):
            return None
        expected_fields = instaloader.FrozenNodeIterator._fields
        kwargs = {field: data.get(field) for field in expected_fields}
        return instaloader.FrozenNodeIterator(**kwargs)
    except Exception:
        return None


def build_loader() -> tuple[instaloader.Instaloader, bool]:
    """Initialize Instaloader in strictly stateless, non-sleeping mode."""
    loader = instaloader.Instaloader(
        sleep=False,
        quiet=True,
        download_pictures=False,
        download_videos=False,
        download_video_thumbnails=False,
        download_geotags=False,
        download_comments=False,
        save_metadata=False,
        compress_json=False,
        max_connection_attempts=2,
        request_timeout=15.0,
        fatal_status_codes=[400, 401, 403, 429],
        iphone_support=False,
    )

    session_id = os.environ.get("INSTAGRAM_SESSION_ID", "").strip()
    env_username = os.environ.get("INSTAGRAM_USERNAME", "").strip().lstrip("@")
    authenticated = False

    if session_id:
        loader.context._session.cookies.set(
            "sessionid",
            session_id,
            domain=".instagram.com",
            path="/",
        )
        if env_username and USERNAME_RE.match(env_username):
            loader.context.username = env_username
            authenticated = True
        else:
            try:
                logged_in_user = loader.test_login()
                if logged_in_user:
                    loader.context.username = logged_in_user
                    authenticated = True
            except Exception:
                authenticated = True

    return loader, authenticated


def serialize_post(post: instaloader.Post, default_source_url: str) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    username = post.owner_username or "instagram"
    shortcode = post.shortcode or "post"
    caption = (post.caption or "").strip().replace("\n", " ")[:110]
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


def extract_profile(
    loader: instaloader.Instaloader,
    username: str,
    source_url: str,
    limit: int,
    offset: int,
    frozen_cursor: Optional[str],
) -> Dict[str, Any]:
    if not USERNAME_RE.match(username):
        return {"ok": False, "error": "Invalid Instagram username format."}

    profile = instaloader.Profile.from_username(loader.context, username)
    if profile.is_private and not profile.followed_by_viewer:
        return {
            "ok": False,
            "authRequired": True,
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
    if thawed:
        for post in itertools.islice(posts_iter, limit):
            page_posts.append(post)
    else:
        for post in itertools.islice(posts_iter, offset, offset + limit):
            page_posts.append(post)

    # Peek whether another post exists and freeze cursor right at next post boundary
    has_more = False
    next_frozen_cursor: Optional[str] = None
    if len(page_posts) == limit:
        try:
            frozen_state = posts_iter.freeze()
            encoded = encode_frozen_iterator(frozen_state)
            if encoded:
                # Check if remaining_data or page_info indicates more posts
                rem = frozen_state.remaining_data or {}
                page_info = rem.get("page_info") if isinstance(rem, dict) else None
                edges = rem.get("edges") if isinstance(rem, dict) else None
                if (isinstance(edges, list) and len(edges) > 0) or (
                    isinstance(page_info, dict) and page_info.get("has_next_page")
                ):
                    has_more = True
                    next_frozen_cursor = encoded
        except Exception:
            has_more = isinstance(total_posts, int) and (offset + len(page_posts) < total_posts)

    items: List[Dict[str, Any]] = []
    for post in page_posts:
        items.extend(serialize_post(post, source_url))

    return {
        "ok": True,
        "items": items,
        "hasMore": has_more,
        "nextFrozenCursor": next_frozen_cursor,
        "nextOffset": offset + len(page_posts) if has_more else None,
        "totalAvailable": total_posts if isinstance(total_posts, int) else None,
        "postsFetched": len(page_posts),
    }


def extract_post(
    loader: instaloader.Instaloader,
    shortcode: str,
    source_url: str,
) -> Dict[str, Any]:
    if not SHORTCODE_RE.match(shortcode):
        return {"ok": False, "error": "Invalid Instagram post shortcode."}

    post = instaloader.Post.from_shortcode(loader.context, shortcode)
    items = serialize_post(post, source_url)
    return {
        "ok": len(items) > 0,
        "items": items,
        "hasMore": False,
        "error": None if items else "No downloadable media found in post.",
    }


def extract_story(
    loader: instaloader.Instaloader,
    authenticated: bool,
    username: str,
    story_id: Optional[str],
    source_url: str,
) -> Dict[str, Any]:
    if not authenticated:
        return {
            "ok": False,
            "authRequired": True,
            "error": "Instagram Stories require INSTAGRAM_SESSION_ID configured on the server.",
        }
    if not USERNAME_RE.match(username):
        return {"ok": False, "error": "Invalid Instagram username for story."}
    if story_id and not NUMERIC_ID_RE.match(story_id):
        return {"ok": False, "error": "Invalid Instagram story ID."}

    profile = instaloader.Profile.from_username(loader.context, username)
    collected_nodes: List[instaloader.StoryItem] = []

    for story in loader.get_stories(userids=[profile.userid]):
        for story_item in story.get_items():
            collected_nodes.append(story_item)

    if story_id:
        filtered = [s for s in collected_nodes if str(s.mediaid) == story_id]
        if filtered:
            collected_nodes = filtered

    total = len(collected_nodes)
    items: List[Dict[str, Any]] = []
    for idx, node in enumerate(collected_nodes, start=1):
        is_video = bool(node.is_video and node.video_url)
        media_url = node.video_url if is_video else node.url
        thumb_url = node.url or media_url
        if not media_url:
            continue
        created_at = node.date_utc.isoformat() + "Z" if getattr(node, "date_utc", None) else None
        items.append(
            {
                "mediaType": "video" if is_video else "image",
                "mediaUrl": media_url,
                "thumbnailUrl": thumb_url,
                "username": node.owner_username or username,
                "title": f"Instagram Story ({node.owner_username or username})",
                "shortcodeOrId": str(node.mediaid or story_id or "story"),
                "sourceUrl": source_url,
                "index": idx,
                "total": total,
                "createdAt": created_at,
            }
        )

    if not items:
        return {
            "ok": False,
            "error": f"No active 24-hour stories found for @{username}.",
        }

    return {"ok": True, "items": items, "hasMore": False}


def extract_highlight(
    loader: instaloader.Instaloader,
    authenticated: bool,
    highlight_id: str,
    source_url: str,
) -> Dict[str, Any]:
    if not authenticated:
        return {
            "ok": False,
            "authRequired": True,
            "error": "Instagram Highlights require INSTAGRAM_SESSION_ID configured on the server.",
        }
    if not NUMERIC_ID_RE.match(highlight_id):
        return {"ok": False, "error": "Invalid Instagram highlight ID."}

    reel_id = f"highlight:{highlight_id}"
    resp = loader.context._session.get(
        f"https://www.instagram.com/api/v1/feed/reels_media/?reel_ids=highlight%3A{highlight_id}",
        headers={
            "x-ig-app-id": "936619743392459",
            "Accept": "application/json",
        },
        timeout=15.0,
    )
    if resp.status_code != 200:
        return {
            "ok": False,
            "authRequired": resp.status_code in (401, 403),
            "error": f"Instagram returned HTTP {resp.status_code} for highlight {highlight_id}.",
        }

    data = resp.json()
    reel = (data.get("reels") or {}).get(reel_id)
    if not reel and isinstance(data.get("reels_media"), list) and data["reels_media"]:
        reel = data["reels_media"][0]

    raw_items = (reel or {}).get("items") or []
    highlight_title = (reel or {}).get("title") or f"Highlight {highlight_id}"
    owner_user = ((reel or {}).get("user") or {}).get("username") or "highlight"

    items: List[Dict[str, Any]] = []
    total = len(raw_items)
    for idx, raw in enumerate(raw_items, start=1):
        video_versions = raw.get("video_versions") or []
        img_candidates = (raw.get("image_versions2") or {}).get("candidates") or []
        if video_versions and video_versions[0].get("url"):
            media_url = video_versions[0]["url"]
            thumb_url = img_candidates[0]["url"] if img_candidates and img_candidates[0].get("url") else media_url
            media_type = "video"
            width = video_versions[0].get("width")
            height = video_versions[0].get("height")
        elif img_candidates and img_candidates[0].get("url"):
            media_url = img_candidates[0]["url"]
            thumb_url = media_url
            media_type = "image"
            width = img_candidates[0].get("width")
            height = img_candidates[0].get("height")
        else:
            continue

        items.append(
            {
                "mediaType": media_type,
                "mediaUrl": media_url,
                "thumbnailUrl": thumb_url,
                "username": owner_user,
                "title": str(highlight_title)[:110],
                "shortcodeOrId": highlight_id,
                "sourceUrl": source_url,
                "index": idx,
                "total": total,
                "width": width,
                "height": height,
            }
        )

    if not items:
        return {"ok": False, "error": f"No media slides found in highlight {highlight_id}."}

    return {"ok": True, "items": items, "hasMore": False}


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
    story_id = str(req.get("storyId") or "").strip() or None
    highlight_id = str(req.get("highlightId") or "").strip()
    frozen_cursor = str(req.get("frozenCursor") or "").strip() or None

    try:
        limit = max(1, min(int(req.get("limit") or 25), 100))
    except (TypeError, ValueError):
        limit = 25

    try:
        offset = max(0, min(int(req.get("offset") or 0), 5000))
    except (TypeError, ValueError):
        offset = 0

    try:
        loader, authenticated = build_loader()

        if content_type == "ig_profile" and username:
            result = extract_profile(loader, username, source_url, limit, offset, frozen_cursor)
        elif content_type in ("ig_post", "ig_reel") and shortcode:
            result = extract_post(loader, shortcode, source_url)
        elif content_type == "ig_story" and username:
            result = extract_story(loader, authenticated, username, story_id, source_url)
        elif content_type == "ig_highlight" and highlight_id:
            result = extract_highlight(loader, authenticated, highlight_id, source_url)
        else:
            result = {"ok": False, "error": "Unsupported Instagram workload target."}

        emit(result)
    except ig_exc.LoginRequiredException:
        emit(
            {
                "ok": False,
                "authRequired": True,
                "error": "Instagram requires an authenticated session for this resource.",
            }
        )
    except ig_exc.PrivateProfileNotFollowedException:
        emit(
            {
                "ok": False,
                "authRequired": True,
                "error": "This Instagram profile is private.",
            }
        )
    except ig_exc.TooManyRequestsException:
        emit(
            {
                "ok": False,
                "rateLimited": True,
                "authRequired": True,
                "error": "Instagram rate-limited this request from the server IP.",
            }
        )
    except ig_exc.QueryReturnedNotFoundException:
        emit(
            {
                "ok": False,
                "error": "Instagram profile or post was not found.",
            }
        )
    except ig_exc.ConnectionException as exc:
        msg = str(exc)
        is_auth_or_limit = any(code in msg for code in ("401", "403", "429", "login"))
        emit(
            {
                "ok": False,
                "authRequired": is_auth_or_limit,
                "rateLimited": "429" in msg,
                "error": f"Instaloader upstream connection declined: {msg[:180]}",
            }
        )
    except Exception as exc:
        emit({"ok": False, "error": f"Instaloader worker error: {str(exc)[:180]}"})


if __name__ == "__main__":
    main()
