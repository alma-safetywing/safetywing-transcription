require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

async function main() {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  const { data: videos, error } = await supabase
    .from('videos')
    .select('id, title, file_name, total_duration_ms');

  if (error) throw new Error(error.message);

  const { count } = await supabase
    .from('transcript_chunks')
    .select('*', { count: 'exact', head: true });

  console.log(`\n=== SUPABASE STATS ===`);
  console.log(`Videos ingested: ${videos.length}`);
  console.log(`Total chunks:    ${count}`);
  console.log(`\nVideos list:`);
  videos.forEach(v => {
    const dur = Math.round((v.total_duration_ms || 0) / 60000);
    console.log(`  [${dur}min] ${v.title || v.file_name || v.id}`);
  });
}

main().catch(e => { console.error(e.message); process.exit(1); });
