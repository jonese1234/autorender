# Migrating data from autorender.p2sr.org

We don't have a database backup of the original instance, so [`src/server/tasks/migrate_p2sr.ts`](./src/server/tasks/migrate_p2sr.ts) rebuilds the data by crawling the public site. It enumerates every publicly listed video through the same pagination API the site's infinite scroll uses, parses each video page, and inserts equivalent rows into our `videos` table.

## What it recovers

| Data                                                        | Source                                          | Fidelity |
| ----------------------------------------------------------- | ----------------------------------------------- | -------- |
| share_id (same URLs keep working!), title, comment, views   | listing cards + video page                      | exact    |
| video/thumbnail/preview URLs (Bunny CDN), video length      | listing cards + `og:video`                      | exact    |
| board data: changelog ID, rank, time, player/partner        | video page links                                | exact    |
| map + game                                                  | board chamber ID / workshop ID / demo parse     | exact    |
| requester: Discord ID + username, guild#channel names       | avatar URL + video page                         | exact where shown |
| `created_at`                                                | demo timestamp or page date                     | exact or day-level |
| `rendered_at`                                               | pagination cursors                              | exact for every 16th video, interpolated between |
| all `demo_*` columns                                        | demo file re-parsed with our own parser (`--demos`) | exact    |

**Not recoverable** (never exposed publicly): likes, bookmarks, user accounts/permissions, audit logs, render options, deleted/private/unlisted videos.

## Important caveat: the media files

By default the migrated rows keep pointing at the old instance's **Bunny CDN** URLs for videos, thumbnails and previews. Those work today, but they live on the original developer's account and can disappear. Two-phase approach recommended:

1. **Phase 1 — metadata (fast, ~hours):** run without `--videos`. The site is immediately fully browsable using the old CDN.
2. **Phase 2 — media independence (slow):** mirror the video files. With S3 object storage configured (`S3_ENABLED=true`, see DEPLOY_COOLIFY.md), videos are uploaded straight to the bucket and the local copies are cleaned up by `deno task processing` after it regenerates thumbnails/previews — local disk usage stays bounded. Without S3, videos accumulate in `/storage/videos`, so size the volume first. Two ways to run phase 2:
   - For rows **already migrated** in phase 1: `deno task migrate --remote` — downloads each externally hosted video and uploads it to the bucket (see DEPLOY_COOLIFY.md → *Migrating existing videos*).
   - For a **fresh crawl**: re-run `deno task migrate:p2sr` with `--videos` (already-migrated rows are skipped, so this only covers new rows).

## Usage

Run inside the **server container** (Coolify → resource → `server` → Terminal):

```bash
# 1. Sanity check: crawl 2 pages, parse, print, write nothing
deno task migrate:p2sr --dry-run --max-pages=2

# 2. Small real test: 10 videos incl. demo files
deno task migrate:p2sr --max-videos=10 --demos

# 3. Full run (safe to interrupt and re-run; existing rows are skipped)
deno task migrate:p2sr --demos
```

Flags: `--dry-run`, `--demos` (download+parse demo files), `--videos` (mirror video files locally), `--max-pages=N`, `--max-videos=N`, `--delay=MS` (default 250ms between requests), `--source=URL`.

A full run at the default delay does roughly 2 requests/second against the old site — a crawl of ~30k videos takes in the order of 5–8 hours. Run it in a detached shell (e.g. `nohup deno task migrate:p2sr --demos > /logs/server/migration.log 2>&1 &`) so closing the terminal doesn't kill it, and watch the log.

## After the run

- Spot-check a few migrated video pages on your domain (same `/videos/<share_id>` paths as the old site).
- If you used `--videos`: run `deno task processing` to generate thumbnails/previews.
- Take a database backup (see DEPLOY_COOLIFY.md → Ongoing operations) — from now on there's real data to lose.
