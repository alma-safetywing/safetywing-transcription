-- Add title column to videos table
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New query)
alter table videos add column if not exists title text;

-- Update the speaker_list view to include title context (optional but useful)
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
