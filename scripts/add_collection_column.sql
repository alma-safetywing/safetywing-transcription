-- Add a "collection" column to videos — tags which parent folder a video
-- came from (e.g. "Norway 2026", "SF Content Week 2026", "Webinars"), so the
-- search UI can filter results to just one event/source instead of always
-- searching everything.
--
-- Non-destructive — safe to run on the live database (ALTER ... IF NOT
-- EXISTS, CREATE OR REPLACE). Does NOT touch schema.sql's full drop/recreate,
-- since that file is only for fresh installs.
--
-- Run this in the Supabase SQL editor (Dashboard → SQL Editor → New query).

ALTER TABLE videos ADD COLUMN IF NOT EXISTS collection TEXT;

CREATE INDEX IF NOT EXISTS idx_videos_collection ON videos(collection);

-- ============================================================
-- Updated search function: adds an optional filter_collection param.
-- Needs to join transcript_chunks → videos to know each clip's collection,
-- which the original function didn't do (it only touched transcript_chunks).
-- CREATE OR REPLACE is safe — same signature plus one new trailing param
-- with a default, so existing callers that don't pass it are unaffected.
-- ============================================================
create or replace function search_clips(
  query_embedding    vector(1536),
  min_duration_ms    integer default null,
  max_duration_ms    integer default null,
  filter_speaker     text    default null,
  filter_chunk_type  text    default null,
  match_count        integer default 5,
  filter_collection  text    default null   -- e.g. 'Norway 2026'
)
returns table (
  id            uuid,
  video_id      text,
  speaker_label text,
  speaker_name  text,
  text          text,
  start_ms      integer,
  end_ms        integer,
  duration_ms   integer,
  chunk_type    text,
  similarity    float
)
language sql stable
as $$
  select
    c.id,
    c.video_id,
    c.speaker_label,
    c.speaker_name,
    c.text,
    c.start_ms,
    c.end_ms,
    c.duration_ms,
    c.chunk_type,
    1 - (c.embedding <=> query_embedding) as similarity
  from transcript_chunks c
  left join videos v on v.id = c.video_id
  where
    c.embedding is not null
    and (min_duration_ms is null or c.duration_ms >= min_duration_ms)
    and (max_duration_ms is null or c.duration_ms <= max_duration_ms)
    and (filter_speaker    is null or c.speaker_name ilike '%' || filter_speaker || '%')
    and (filter_chunk_type is null or c.chunk_type = filter_chunk_type)
    and (filter_collection is null or v.collection = filter_collection)
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

-- ============================================================
-- Helper view: distinct collections + how many videos/clips each has.
-- Powers the "Folder" filter dropdown in the search UI.
-- ============================================================
create or replace view collection_list as
select
  collection,
  count(*) as video_count
from videos
where collection is not null
group by collection
order by collection;
