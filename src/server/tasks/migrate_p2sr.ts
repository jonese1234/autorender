/*
 * Copyright (c) 2023-2025, NeKz
 *
 * SPDX-License-Identifier: MIT
 *
 * Migrates video data from the original autorender.p2sr.org instance into this
 * instance's database by crawling the public site (no DB access required).
 *
 * What it does:
 *   1. Crawls the home feed (/api/v1/videos/more/home) to enumerate every
 *      publicly listed video: share_id, title, views, thumbnail, preview,
 *      video length, requester Discord ID and an approximate rendered_at
 *      (exact for every 16th video via the pagination cursor, interpolated
 *      in between).
 *   2. Fetches each video page to extract: comment, video URL, board data
 *      (changelog ID, rank, time, player/partner steam IDs and names), map,
 *      created_at and requester info.
 *   3. Inserts rows into the `videos` table. Videos already present (matched
 *      by share_id) are skipped, so the script is safe to re-run and resume.
 *
 * Optional flags:
 *   --dry-run          Crawl and parse but do not write to the database.
 *   --demos            Download demo files into the demos folder and parse
 *                      them to fill all demo_* columns precisely.
 *   --videos           Download video files into the videos folder and point
 *                      video_url at this instance. Sets processed=0 so that
 *                      `deno task processing` regenerates thumbnails/previews
 *                      locally. WARNING: needs a lot of disk space.
 *   --max-pages=N      Stop crawling the listing after N pages (16 videos per
 *                      page). Useful for testing.
 *   --max-videos=N     Stop after migrating N new videos.
 *   --delay=MS         Delay between requests in milliseconds (default 250).
 *   --source=URL       Source instance (default https://autorender.p2sr.org).
 *
 * Usage (inside the server container):
 *   deno task migrate:p2sr -- --dry-run --max-pages=2
 *   deno task migrate:p2sr -- --demos
 */

import { db } from '../db.ts';
import { getDemoInfo } from '../demo.ts';
import { S3Client } from '../s3.ts';
import { getDemoFilePath, getVideoDownloadFilename, getVideoFilePath, validateShareId } from '../utils.ts';
import { BoardSource, FixedDemoStatus, PendingStatus, RenderQuality, VisibilityState } from '~/shared/models.ts';

const args = new Map<string, string>(
  Deno.args
    .filter((arg) => arg.startsWith('--'))
    .map((arg) => {
      const eq = arg.indexOf('=');
      return eq === -1 ? [arg.slice(2), 'true'] : [arg.slice(2, eq), arg.slice(eq + 1)];
    }),
);

const SOURCE = (args.get('source') ?? 'https://autorender.p2sr.org').replace(/\/+$/, '');
const DRY_RUN = args.has('dry-run');
const DOWNLOAD_DEMOS = args.has('demos');
const DOWNLOAD_VIDEOS = args.has('videos');
const MAX_PAGES = Number(args.get('max-pages') ?? Infinity);
const MAX_VIDEOS = Number(args.get('max-videos') ?? Infinity);
const DELAY_MS = Number(args.get('delay') ?? 250);

const USER_AGENT = `${Deno.env.get('USER_AGENT') ?? 'autorender-server/1.0.0'} (p2sr-migration)`;
const AUTORENDER_PUBLIC_URI = Deno.env.get('AUTORENDER_PUBLIC_URI')!;
const S3_ENABLED = Deno.env.get('S3_ENABLED')?.toLowerCase() === 'true';

// With S3 enabled, mirrored videos (--videos) go straight to the bucket
// instead of accumulating on local disk. The processing task deletes each
// local copy after regenerating thumbnails/previews from it.
const s3 = S3_ENABLED
  ? new S3Client({
    userAgent: USER_AGENT,
    endpoint: Deno.env.get('S3_ENDPOINT')!,
    region: Deno.env.get('S3_REGION')!,
    bucket: Deno.env.get('S3_BUCKET')!,
    accessKey: Deno.env.get('S3_ACCESS_KEY')!,
    secretKey: Deno.env.get('S3_SECRET_KEY')!,
  })
  : null;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const request = async (url: string, init?: RequestInit): Promise<Response> => {
  for (let attempt = 1;; attempt += 1) {
    try {
      const res = await fetch(url, {
        ...init,
        headers: {
          'User-Agent': USER_AGENT,
          ...(init?.headers ?? {}),
        },
      });

      if (res.status === 429 || res.status >= 500) {
        await res.body?.cancel();

        if (attempt >= 5) {
          throw new Error(`Giving up on ${url} : ${res.status}`);
        }

        const retryAfter = Number(res.headers.get('Retry-After') ?? 0);
        const backoff = Math.max(retryAfter * 1_000, attempt * 2_000);
        console.log(`  [!] ${res.status} for ${url}, retrying in ${backoff}ms`);
        await sleep(backoff);
        continue;
      }

      return res;
    } catch (err) {
      if (attempt >= 5) {
        throw err;
      }
      console.log(`  [!] ${err instanceof Error ? err.message : err}, retrying`);
      await sleep(attempt * 2_000);
    }
  }
};

const unescapeHtml = (text: string) => {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
};

// "1:23.45" or "23.45" -> centiseconds
const parseCmTime = (formatted: string): number | null => {
  const match = formatted.match(/^(?:(\d+):)?(\d+)\.(\d{2})$/);
  if (!match) {
    return null;
  }
  const [, min, sec, cs] = match;
  return ((Number(min ?? 0) * 60 + Number(sec)) * 100) + Number(cs);
};

// "1:36" or "1:02:36" -> seconds
const parseVideoLength = (formatted: string): number | null => {
  const parts = formatted.split(':').map(Number);
  if (parts.some(isNaN)) {
    return null;
  }
  return parts.reduce((total, part) => total * 60 + part, 0);
};

type ListedVideo = {
  share_id: string;
  title: string;
  views: number;
  thumbnail_url: string | null;
  video_preview_url: string | null;
  video_length: number | null;
  requested_by_id: string | null;
  board_avatar: BoardSource;
  rendered_at: Date;
};

const parseSortableCursor = (cursor: string) => {
  const [shareId, date, views] = atob(cursor).split(',');
  return { shareId: shareId!, date: new Date(date!), views: Number(views) };
};

const makeSortableCursor = (shareId: string, date: Date, views: number) => {
  return btoa(`${shareId},${date.toISOString()},${views}`);
};

const parseListingPage = (html: string): Omit<ListedVideo, 'rendered_at'>[] => {
  const cards = html.replaceAll('<!-- -->', '').split('<a href="/videos/').slice(1);

  return cards.flatMap((card) => {
    const shareId = card.match(/^([0-9A-Za-z_-]{11})"/)?.[1];
    if (!shareId || !validateShareId(shareId)) {
      return [];
    }

    const title = card.match(/title="([^"]*)"/)?.[1];
    const views = card.match(/>(\d+) views? \| /)?.[1];
    const thumbnail = card.match(/src="([^"]+)" alt="thumbnail"/)?.[1];
    const preview = card.match(/x-preview="([^"]+)"/)?.[1];
    const length = card.match(/>(\d+(?::\d{2})+)<\/span>/)?.[1];
    const requesterId = card.match(/\/storage\/avatars\/(\d+)/)?.[1];
    const boardAvatar = card.includes('mel_avatar')
      ? BoardSource.Mel
      : card.includes('autorender_avatar')
      ? BoardSource.Portal2
      : BoardSource.None;

    return [{
      share_id: shareId,
      title: unescapeHtml(title ?? ''),
      views: Number(views ?? 0),
      thumbnail_url: thumbnail ?? null,
      video_preview_url: preview ?? null,
      video_length: length ? parseVideoLength(length) : null,
      requested_by_id: requesterId ?? null,
      board_avatar: boardAvatar,
    }];
  });
};

const crawlListing = async (): Promise<ListedVideo[]> => {
  const videos: ListedVideo[] = [];

  // Synthetic far-future cursor to start at the newest video.
  let cursor = makeSortableCursor('AAAAAAAAAA0', new Date('2100-01-01T00:00:00.000Z'), 999_999_999);
  let previousExact = new Date();
  let page = 0;

  while (page < MAX_PAGES) {
    page += 1;

    const res = await request(`${SOURCE}/api/v1/videos/more/home?l=${encodeURIComponent(cursor)}`, {
      headers: { 'Accept': 'text/html' },
    });

    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`Listing request failed: ${res.status}`);
    }

    const nextCursor = res.headers.get('X-Last-Video');
    const cards = parseListingPage(await res.text());

    if (!cards.length) {
      break;
    }

    // The cursor holds the exact rendered_at of the last card on this page.
    // Interpolate the cards in between to preserve the global ordering. The
    // first page has no upper bound, so space its cards one minute apart
    // instead of stretching them towards the current time.
    const pageExact = nextCursor ? parseSortableCursor(nextCursor).date : previousExact;
    const lower = pageExact.getTime();
    const upper = page === 1 ? lower + cards.length * 60_000 : previousExact.getTime();

    cards.forEach((card, idx) => {
      videos.push({
        ...card,
        rendered_at: new Date(upper - ((idx + 1) / cards.length) * (upper - lower)),
      });
    });

    previousExact = pageExact;

    console.log(
      `[+] Listing page ${page}: ${cards.length} videos (total ${videos.length}, oldest ${pageExact.toISOString()})`,
    );

    if (!nextCursor || nextCursor === cursor || cards.length < 16) {
      break;
    }

    cursor = nextCursor;
    await sleep(DELAY_MS);
  }

  return videos;
};

type PageDetails = {
  comment: string | null;
  video_url: string | null;
  views: number | null;
  board_domain: string | null;
  board_chamber_id: number | null;
  board_changelog_id: number | null;
  board_rank: number | null;
  workshop_file_id: string | null;
  map_alias: string | null;
  demo_player_name: string | null;
  demo_steam_id: string | null;
  demo_partner_player_name: string | null;
  demo_partner_steam_id: string | null;
  demo_time_score: number | null;
  created_at: Date | null;
  requested_by_username: string | null;
  requested_in_guild_name: string | null;
  requested_in_channel_name: string | null;
};

const parseVideoPage = (rawHtml: string): PageDetails => {
  const html = rawHtml.replaceAll('<!-- -->', '');

  const meta = (name: string) => {
    const value = html.match(new RegExp(`<meta name="${name}" content="([^"]*)"`))?.[1];
    return value !== undefined ? unescapeHtml(value) : null;
  };

  const chamber = html.match(/href="https:\/\/([^"/]+)\/chamber\/(\d+)"[^>]*>([^<]+)</);
  const workshop = html.match(/steamcommunity\.com\/workshop\/filedetails\/\?id=(\d+)"[^>]*>([^<]+)</);
  const changelog = html.match(/changelog\?id=(\d+)/);
  const rank = html.match(/Rank at time of upload: (\d+)(?:st|nd|rd|th)/);
  const time = html.match(/Time: (?:<a[^>]*>)?(\d+(?::\d{2})?\.\d{2})/);
  const views = html.match(/>(\d+) views?</);

  // Player/partner profile links are absolute (board or Steam profiles).
  const players = [...html.matchAll(/href="https:\/\/[^"]*\/profiles?\/(\d+)"[^>]*>([^<]+)</g)]
    .filter(([, , name]) => name !== undefined);

  // Exact timestamp from demo metadata, otherwise the locale-formatted date.
  let createdAt: Date | null = null;
  const timestamp = html.match(/Timestamp: (\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2}) UTC/);
  if (timestamp) {
    const [, y, mo, d, h, mi, s] = timestamp;
    createdAt = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`);
  } else {
    const date = html.match(/Date: (\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (date) {
      const [, month, day, year] = date;
      createdAt = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 12));
    }
  }

  const requestedBy = html.match(/Requested by: <a[^>]*href="\/profile\/([^"]+)"/) ??
    html.match(/Requested by: ([^<]+)</);
  const requestedIn = html.match(/Requested in: ([^<]+?)#([^<]+)</);

  const boardDomain = chamber?.[1] ?? null;

  return {
    comment: meta('og:description'),
    video_url: meta('og:video'),
    views: views ? Number(views[1]) : null,
    board_domain: boardDomain,
    board_chamber_id: chamber ? Number(chamber[2]) : null,
    board_changelog_id: changelog ? Number(changelog[1]) : null,
    board_rank: rank ? Number(rank[1]) : null,
    workshop_file_id: workshop?.[1] ?? null,
    map_alias: unescapeHtml(chamber?.[3] ?? workshop?.[2] ?? '') || null,
    demo_player_name: players[0] ? unescapeHtml(players[0][2]!) : null,
    demo_steam_id: players[0]?.[1] ?? null,
    demo_partner_player_name: players[1] ? unescapeHtml(players[1][2]!) : null,
    demo_partner_steam_id: players[1]?.[1] ?? null,
    demo_time_score: time ? parseCmTime(time[1]!) : null,
    created_at: createdAt,
    requested_by_username: requestedBy ? unescapeHtml(requestedBy[1]!.trim()) : null,
    requested_in_guild_name: requestedIn ? unescapeHtml(requestedIn[1]!.trim()) : null,
    requested_in_channel_name: requestedIn ? unescapeHtml(requestedIn[2]!.trim()) : null,
  };
};

const downloadFile = async (url: string, filePath: string): Promise<number | null> => {
  const res = await request(url);
  if (!res.ok || !res.body) {
    await res.body?.cancel();
    return null;
  }

  try {
    await Deno.remove(filePath);
  } catch {
    // ignore
  }

  using file = await Deno.open(filePath, { create: true, write: true, truncate: true });
  await res.body.pipeTo(file.writable);

  return (await Deno.stat(filePath)).size;
};

const migrate = async () => {
  console.log(`[+] Source: ${SOURCE}`);
  console.log(
    `[+] Options: ${DRY_RUN ? 'dry-run ' : ''}${DOWNLOAD_DEMOS ? 'demos ' : ''}${DOWNLOAD_VIDEOS ? 'videos' : ''}`,
  );

  const existing = new Set(
    (await db.query<{ share_id: string }>(`select share_id from videos`)).map(({ share_id }) => share_id),
  );
  console.log(`[+] Videos already in database: ${existing.size}`);

  const listing = await crawlListing();
  const pending = listing.filter((video) => !existing.has(video.share_id));
  console.log(`[+] Found ${listing.length} videos, ${pending.length} to migrate`);

  let migrated = 0;
  let failed = 0;

  for (const listed of pending) {
    if (migrated >= MAX_VIDEOS) {
      break;
    }

    await sleep(DELAY_MS);

    try {
      const res = await request(`${SOURCE}/videos/${listed.share_id}`);
      if (!res.ok) {
        await res.body?.cancel();
        console.log(`[-] ${listed.share_id}: page returned ${res.status}, skipping`);
        failed += 1;
        continue;
      }

      const page = parseVideoPage(await res.text());

      const boardSource = page.board_domain
        ? (page.board_domain.includes('mel') ? BoardSource.Mel : BoardSource.Portal2)
        : BoardSource.None;

      // Map lookup: board videos via the board map ID, workshop maps via the
      // workshop file ID. Plain user uploads are resolved from the demo below.
      let mapId: number | null = null;
      let gameId: number | null = null;

      if (boardSource !== BoardSource.None && page.board_chamber_id !== null) {
        gameId = boardSource === BoardSource.Mel ? 4 : 1;
        const [map] = await db.query<{ map_id: number }>(
          `select map_id from maps where game_id = ? and best_time_id = ?`,
          [gameId, page.board_chamber_id],
        );
        mapId = map?.map_id ?? null;
      } else if (page.workshop_file_id !== null) {
        const [map] = await db.query<{ map_id: number; game_id: number }>(
          `select map_id, game_id from maps where workshop_file_id = ?`,
          [page.workshop_file_id],
        );
        mapId = map?.map_id ?? null;
        gameId = map?.game_id ?? 1;
      }

      // Optionally download + parse the demo for exact demo_* columns.
      // deno-lint-ignore no-explicit-any
      let demo: any = null;
      let demoSize: number | null = null;

      if (DOWNLOAD_DEMOS && !DRY_RUN) {
        const demoUrl = boardSource !== BoardSource.None && page.board_changelog_id !== null
          ? `https://${page.board_domain}/getDemo?id=${page.board_changelog_id}`
          : `${SOURCE}/storage/demos/${listed.share_id}`;

        const demoPath = getDemoFilePath({ share_id: listed.share_id });
        demoSize = await downloadFile(demoUrl, demoPath);

        if (demoSize !== null) {
          const demoInfo = await getDemoInfo(demoPath, { isBoardDemo: boardSource !== BoardSource.None });
          if (demoInfo !== null && typeof demoInfo !== 'string') {
            demo = demoInfo;

            if (mapId === null) {
              const [game] = await db.query<{ game_id: number }>(
                `select game_id from games where game_mod = ?`,
                [demo.gameDir],
              );
              if (game) {
                gameId = game.game_id;
                const [map] = await db.query<{ map_id: number }>(
                  `select map_id from maps where game_id = ? and name = ?`,
                  [gameId, demo.fullMapName],
                );
                mapId = map?.map_id ?? null;
              }
            }
          }
        }
      }

      const title = (listed.title || page.map_alias || listed.share_id).slice(0, 64);

      // Optionally mirror the video file to this instance.
      let videoUrl = page.video_url;
      let videoSize: number | null = null;
      let videoExternalId: string | null = videoUrl?.match(/b-cdn\.net\/([0-9a-f-]{36})\//)?.[1] ?? null;
      let thumbnailUrl: string | null = listed.thumbnail_url;
      let previewUrl: string | null = listed.video_preview_url;
      let processed = 1;

      if (DOWNLOAD_VIDEOS && !DRY_RUN && page.video_url) {
        const videoPath = getVideoFilePath({ share_id: listed.share_id });
        videoSize = await downloadFile(page.video_url, videoPath);

        if (videoSize !== null) {
          if (s3) {
            const fileName = `${listed.share_id}.mp4`;

            await s3.putObject({
              key: fileName,
              contents: await Deno.readFile(videoPath),
              contentType: 'video/mp4',
              // NOTE: 'inline' so that the video plays in the browser.
              contentDisposition: `inline; filename="${
                encodeURIComponent(getVideoDownloadFilename({ title, file_name: title.endsWith('.dem') ? title : '' }))
              }"`,
            });

            videoUrl = s3.getObjectUrl(fileName);
            videoExternalId = fileName;
          } else {
            videoUrl = `${AUTORENDER_PUBLIC_URI}/storage/videos/${listed.share_id}`;
            videoExternalId = null;
          }

          thumbnailUrl = null;
          previewUrl = null;
          processed = 0; // `deno task processing` regenerates thumbnails/previews.
        } else {
          console.log(`[-] ${listed.share_id}: video download failed, keeping remote URL`);
        }
      }

      const columns: Record<string, unknown> = {
        game_id: gameId ?? 1,
        map_id: mapId,
        share_id: listed.share_id,
        title,
        comment: page.comment?.slice(0, 512) ?? null,
        requested_by_name: page.requested_by_username?.slice(0, 64) ?? null,
        requested_by_id: listed.requested_by_id,
        requested_in_guild_name: page.requested_in_guild_name?.slice(0, 128) ?? null,
        requested_in_channel_name: page.requested_in_channel_name?.slice(0, 128) ?? null,
        created_at: page.created_at ?? listed.rendered_at,
        render_quality: RenderQuality.HD_720p,
        file_name: title.endsWith('.dem') ? title : null,
        full_map_name: demo?.fullMapName ?? null,
        demo_size: demo?.size ?? demoSize,
        demo_map_crc: demo?.mapCrc ?? null,
        demo_game_dir: demo?.gameDir ?? null,
        demo_playback_time: demo?.playbackTime ?? null,
        demo_required_fix: demo?.useFixedDemo ? FixedDemoStatus.Required : FixedDemoStatus.NotRequired,
        demo_tickrate: demo?.tickrate ?? null,
        demo_portal_score: demo?.portalScore ?? null,
        demo_time_score: demo?.timeScore ?? page.demo_time_score,
        demo_player_name: demo?.playerName ?? page.demo_player_name?.slice(0, 64) ?? null,
        demo_steam_id: demo?.steamId ?? page.demo_steam_id,
        demo_partner_player_name: demo?.partnerPlayerName ?? page.demo_partner_player_name?.slice(0, 64) ?? null,
        demo_partner_steam_id: demo?.partnerSteamId ?? page.demo_partner_steam_id,
        demo_is_host: demo?.isHost ?? null,
        demo_metadata: demo ? JSON.stringify(demo.metadata) : null,
        board_source: boardSource,
        board_changelog_id: page.board_changelog_id,
        board_profile_number: boardSource !== BoardSource.None ? page.demo_steam_id : null,
        board_rank: page.board_rank,
        pending: PendingStatus.FinishedRender,
        rendered_at: listed.rendered_at,
        video_url: videoUrl,
        video_external_id: videoExternalId,
        video_size: videoSize,
        video_length: listed.video_length,
        video_preview_url: previewUrl,
        thumbnail_url_small: thumbnailUrl,
        thumbnail_url_large: thumbnailUrl,
        processed,
        views: page.views ?? listed.views,
        visibility: VisibilityState.Public,
      };

      if (DRY_RUN) {
        console.log(`[+] Would migrate ${listed.share_id}: "${title}" (${JSON.stringify(columns.video_url)})`);
        migrated += 1;
        continue;
      }

      const names = Object.keys(columns);
      await db.execute(
        `insert into videos (video_id, ${names.join(', ')})
              values (UUID_TO_BIN(?), ${names.map(() => '?').join(', ')})`,
        [crypto.randomUUID(), ...Object.values(columns)],
      );

      migrated += 1;
      console.log(`[+] Migrated ${listed.share_id}: "${title}" (${migrated}/${pending.length})`);
    } catch (err) {
      failed += 1;
      console.log(`[-] ${listed.share_id}: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(`[+] Done. Migrated ${migrated} videos, ${failed} failures, ${existing.size} pre-existing.`);

  if (DOWNLOAD_VIDEOS) {
    console.log(`[+] Run "deno task processing" to generate local thumbnails and previews.`);
  }

  Deno.exit(0);
};

await migrate();
