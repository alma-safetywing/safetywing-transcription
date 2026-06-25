#!/bin/bash
#
# run_norway_cron.sh
#
# Invoked on a schedule by launchd (see launchd/com.safetywing.norway-transcribe.plist).
# Safe to run as often as you like -- dedup happens against Supabase (by source
# Drive file ID), not local state, so a run that finds nothing new just exits
# quickly and does nothing.
#
# Runs through an interactive login shell (-ilc) so it picks up node exactly
# the way your normal Terminal does (nvm, Homebrew path, etc.) -- launchd jobs
# otherwise start with a bare-bones environment that doesn't know where node is.

/bin/zsh -ilc 'cd "/Users/almaandino/Claude/Projects/Flight Week content engine" && echo "=== $(date) ===" && node scripts/process_norway_videos.js'
