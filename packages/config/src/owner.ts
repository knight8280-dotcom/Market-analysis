/**
 * The single owner's user id in the per-user tables (ADR-015, ADR-018). A fixed value: with one
 * account there is no user table. A Supabase Auth deploy re-keys rows to auth.uid().
 */
export const OWNER_USER_ID = "00000000-0000-0000-0000-000000000001";
