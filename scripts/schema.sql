-- ============================================================
-- SafetyWing Clip Search Engine — Supabase Schema
-- ============================================================
-- Run this in the Supabase SQL editor (Dashboard → SQL Editor → New query)
-- Safe to run multiple times (uses IF NOT EXISTS / OR REPLACE).
-- ============================================================

-- 1. Clean slate (safe to re-run — drops existing tables first)
drop table if exists transcript_chunks cascade;
drop table if exists videos cascade;

-- 2. Enable pgvector extension
create extension if not exists vector;


-- ============================================================
-- 2. Videos table
--    One row per transcript file (e.g. CODC3_0002_1)
-- ============================================================
create table if not exists videos (
  id                text primary key,         -- e.g. "CODC3_0002_1"
  file_name         text not null,            -- original filename
  drive_file_id     text,                     -- Google Drive file ID of the transcript JSON
  video_drive_id    text,                     -- Google Drive file ID of the source video
  collection        text,                     -- parent folder/event, e.g. "Norway 2026", "SF Content Week 2026", "Webinars"
  total_duration_ms integer,                  -- full video length in ms
  speaker_count     integer,                  -- number of distinct speakers
  ingested_at       timestamptz default now(),
  updated_at        timestamptz default now()
);


-- ============================================================
-- 3. Transcript chunks table
--    Each row is a searchable clip window.
--    chunk_type: 'segment' (natural speaker turn) | '30s' | '60s' | '90s'
-- ============================================================
create table if not exists transcript_chunks (
  id            uuid primary key default gen_random_uuid(),
  video_id      text not null references videos(id) on delete cascade,
  speaker_label text,                         -- "Speaker 1"   (original label)
  speaker_name  text,                         -- "Sondre Rasch" (from mappings)
  text          text not null,                -- transcript text for this chunk
  start_ms      integer not null,             -- clip start in milliseconds
  end_ms        integer not null,             -- clip end in milliseconds
  duration_ms   integer generated always as (end_ms - start_ms) stored,
  chunk_type    text not null,                -- 'segment' | '30s' | '60s' | '90s'
  embedding     vector(1536),                 -- OpenAI text-embedding-3-small
  created_at    timestamptz default now()
);


-- ============================================================
-- 4. Indexes
-- ============================================================

-- Fast lookup by video
create index if not exists idx_chunks_video_id
  on transcript_chunks(video_id);

-- Fast lookup by speaker name (e.g. find all Sondre clips)
create index if not exists idx_chunks_speaker_name
  on transcript_chunks(speaker_name);

-- Fast filtering by duration (for platform-specific length filters)
create index if not exists idx_chunks_duration
  on transcript_chunks(duration_ms);

-- Fast filtering by chunk type
create index if not exists idx_chunks_type
  on transcript_chunks(chunk_type);

-- Fast filtering by parent-folder collection (Norway 2026, SF Content Week 2026, Webinars, ...)
create index if not exists idx_videos_collection
  on videos(collection);

-- Vector index for semantic search (IVFFlat — good up to ~1M rows)
-- Note: create this AFTER you have ingested at least a few hundred rows,
-- otherwise Postgres can't pick the right number of lists.
-- Uncomment and run separately once you have data:
--
-- create index idx_chunks_embedding
--   on transcript_chunks
--   using ivfflat (embedding vector_cosine_ops)
--   with (lists = 100);


-- ============================================================
-- 5. Search function
--    Called by the API: pass a query embedding + optional filters.
--    Returns ranked clips with similarity score.
-- ============================================================
create or replace function search_clips(
  query_embedding    vector(1536),
  min_duration_ms    integer default null,   -- e.g. 20000 for ≥20s clips
  max_duration_ms    integer default null,   -- e.g. 60000 for ≤60s clips
  filter_speaker     text    default null,   -- e.g. 'Sondre Rasch'
  filter_chunk_type  text    default null,   -- e.g. '30s'
  match_count        integer default 5,
  filter_collection  text    default null    -- e.g. 'Norway 2026'
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
-- 6. Helper view: distinct speakers across all videos
--    Useful for building a speaker filter dropdown in the UI.
-- ============================================================
create or replace view speaker_list as
select
  speaker_name,
  count(distinct video_id) as video_count,
  count(*) as clip_count
from transcript_chunks
where speaker_name is not null
  and speaker_name not ilike '%interviewer%'
  and speaker_name not ilike '%crew%'
group by speaker_name
order by video_count desc;


-- ============================================================
-- 7. Helper view: distinct collections (parent folders) across all videos.
--    Powers the "Folder" filter dropdown in the search UI.
-- ============================================================
create or replace view collection_list as
select
  collection,
  count(*) as video_count
from videos
where collection is not null
group by collection
order by collection;
