-- ═══════════════════════════════════════════════════
--  ANGADI — Today's Market Board
--  Run in: Supabase Dashboard → SQL Editor → Run
-- ═══════════════════════════════════════════════════

alter table products add column if not exists cut_time   text;        -- "5:30 AM"
alter table products add column if not exists stock_qty  int default 0;
alter table products add column if not exists board_date date;        -- date admin last published

-- ═══════════════════════════════════════════════════
