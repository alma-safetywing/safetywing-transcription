-- Fixes "Could not choose the best candidate function" caused by
-- add_collection_column.sql's CREATE OR REPLACE FUNCTION search_clips(...)
-- adding a new trailing parameter (filter_collection). Postgres treats a
-- different parameter list as a DIFFERENT function rather than replacing
-- the old one, so the database ended up with two overloaded search_clips
-- functions -- and a Supabase RPC call with named params matches both.
--
-- This drops the old 6-parameter version explicitly, leaving only the
-- 7-parameter version (with filter_collection) in place.
--
-- Safe to run multiple times.

DROP FUNCTION IF EXISTS public.search_clips(vector, integer, integer, text, text, integer);

-- Re-assert the correct (7-parameter) version, in case it somehow got
-- dropped too or never landed correctly.
create or replace function search_clips(
  query_embedding    vector(1536),
  min_duration_ms    integer default null,
  max_duration_ms    integer default null,
  filter_speaker     text    default null,
  filter_chunk_type  text    default null,
  match_count        integer default 5,
  filter_collection  text    default null
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

-- Confirm only one version remains:
-- select proname, pg_get_function_identity_arguments(oid) from pg_proc where proname = 'search_clips';
