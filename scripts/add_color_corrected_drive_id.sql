-- Add color_corrected_drive_id column to videos table
-- Records the Drive file ID of the color-corrected copy (uploaded by
-- color_correct_cam1.js into SF Content Week 2026/Videos) for videos that
-- have one. The search app prefers this over the original video_drive_id
-- when building the "Open video" link, so results point at the corrected
-- footage instead of the raw original once a correction exists.

ALTER TABLE videos ADD COLUMN IF NOT EXISTS color_corrected_drive_id TEXT;
