// ═══════════════════════════════════════════════════════════════
//  Instagram stats for the daily growth agent (READ-ONLY).
//
//  Uses the Instagram Graph API (Business account linked to a
//  Facebook Page). Never posts, comments or messages anyone.
//
//  Env (Vercel → Settings → Env Vars):
//    IG_USER_ID       the Instagram Business account id (17841…)
//    IG_ACCESS_TOKEN  long-lived token with instagram_basic,
//                     instagram_manage_insights, pages_read_engagement
//                     (falls back to META_ACCESS_TOKEN if that system-user
//                     token was granted those permissions too)
//
//  Returns { lines: [...], error? } — lines are appended to the
//  "Growth digest" alert. If not configured, returns a one-line hint
//  instead of failing the whole digest.
// ═══════════════════════════════════════════════════════════════

const GRAPH = 'https://graph.facebook.com/v20.0';
const DAY = 24 * 3600 * 1000;

async function graph(path, token) {
  const sep = path.includes('?') ? '&' : '?';
  const r = await fetch(`${GRAPH}/${path}${sep}access_token=${encodeURIComponent(token)}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error((j.error && j.error.message) || `Graph ${r.status}`);
  return j;
}

// Per-post insights. Metric names differ by post type and Meta keeps
// renaming them, so ask for the safe set and tolerate failure per post.
async function postInsights(id, token) {
  try {
    const j = await graph(`${id}/insights?metric=reach,saved,shares,total_interactions`, token);
    const out = {};
    (j.data || []).forEach((m) => { out[m.name] = (m.values && m.values[0] && m.values[0].value) || 0; });
    return out;
  } catch (_) { return {}; }
}

function shortCaption(c) {
  const s = String(c || '').replace(/\s+/g, ' ').trim();
  return s ? `"${s.slice(0, 40)}${s.length > 40 ? '…' : ''}"` : '(no caption)';
}

// prev = { followers, at } from the last run (site_settings 'ig_stats')
async function getInstagramDigest(env, prev) {
  const userId = env.IG_USER_ID;
  const token = env.IG_ACCESS_TOKEN || env.META_ACCESS_TOKEN;
  if (!userId || !token) {
    return { lines: ['Instagram: not connected yet (set IG_USER_ID and IG_ACCESS_TOKEN in Vercel).'] };
  }
  try {
    const acct = await graph(`${userId}?fields=username,followers_count,media_count`, token);
    const media = await graph(
      `${userId}/media?fields=id,caption,media_product_type,permalink,timestamp,like_count,comments_count&limit=25`, token);

    const weekAgo = Date.now() - 7 * DAY;
    const recent = (media.data || []).filter((m) => new Date(m.timestamp).getTime() >= weekAgo);
    const withStats = await Promise.all(recent.map(async (m) => ({ ...m, ins: await postInsights(m.id, token) })));

    const followers = Number(acct.followers_count) || 0;
    const delta = prev && typeof prev.followers === 'number' ? followers - prev.followers : null;
    const lines = [
      `Instagram @${acct.username}: ${followers} followers` +
        (delta === null ? '' : ` (${delta >= 0 ? '+' : ''}${delta} since last digest)`) +
        `, ${recent.length} post${recent.length === 1 ? '' : 's'} in the last 7 days.`,
    ];

    const yesterday = withStats.filter((m) => new Date(m.timestamp).getTime() >= Date.now() - DAY);
    if (!recent.length) {
      lines.push('Instagram: nothing posted this week. Post at least one reel before the next order window.');
    } else {
      const ranked = withStats.slice().sort((a, b) => (b.ins.reach || 0) - (a.ins.reach || 0));
      const fmt = (m) => {
        const kind = m.media_product_type === 'REELS' ? 'reel' : 'post';
        const bits = [`reach ${m.ins.reach ?? '–'}`, `likes ${m.like_count ?? 0}`, `comments ${m.comments_count ?? 0}`];
        if (m.ins.saved) bits.push(`saves ${m.ins.saved}`);
        if (m.ins.shares) bits.push(`shares ${m.ins.shares}`);
        return `${kind} ${shortCaption(m.caption)}: ${bits.join(', ')} ${m.permalink}`;
      };
      lines.push(`Best this week: ${fmt(ranked[0])}`);
      if (ranked.length > 1) lines.push(`Weakest this week: ${fmt(ranked[ranked.length - 1])}`);
      if (yesterday.length) lines.push(`Posted in last 24h: ${yesterday.map(fmt).join(' | ')}`);
    }
    return { lines, followers };
  } catch (e) {
    return { lines: [`Instagram: could not read stats (${String(e.message || e).slice(0, 140)}). Token may have expired.`], error: true };
  }
}

module.exports = { getInstagramDigest };
