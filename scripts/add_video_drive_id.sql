-- Add video_drive_id column to videos table
-- This stores the Drive file ID of the source video (not the transcript JSON)
-- so the webapp can link directly to the video: drive.google.com/file/d/{id}/view

ALTER TABLE videos ADD COLUMN IF NOT EXISTS video_drive_id TEXT;
