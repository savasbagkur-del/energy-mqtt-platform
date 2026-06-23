import type { Pool } from "pg";

export type PanelUserRole = "admin" | "operator" | "viewer";

export interface PanelUserRow {
  id: string;
  username: string;
  password_hash: string;
  password_md5: string | null;
  role: PanelUserRole;
  is_active: boolean;
  customer_id: string | null;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

/** Public shape (never leaks password_hash). */
export interface PanelUserPublic {
  id: string;
  username: string;
  role: PanelUserRole;
  is_active: boolean;
  customer_id: string | null;
  created_at: string;
  last_login_at: string | null;
}

export const toPublicPanelUser = (row: PanelUserRow): PanelUserPublic => ({
  id: row.id,
  username: row.username,
  role: row.role,
  is_active: row.is_active,
  customer_id: row.customer_id != null ? String(row.customer_id) : null,
  created_at: row.created_at,
  last_login_at: row.last_login_at
});

export const countPanelUsers = async (pool: Pool): Promise<number> => {
  const res = await pool.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM panel_users");
  return Number(res.rows[0]?.n ?? "0");
};

export const getPanelUserByUsername = async (
  pool: Pool,
  username: string
): Promise<PanelUserRow | null> => {
  const res = await pool.query<PanelUserRow>(
    "SELECT * FROM panel_users WHERE lower(username) = lower($1)",
    [username]
  );
  return res.rows[0] ?? null;
};

export const getPanelUserById = async (pool: Pool, id: string): Promise<PanelUserRow | null> => {
  const res = await pool.query<PanelUserRow>("SELECT * FROM panel_users WHERE id = $1", [id]);
  return res.rows[0] ?? null;
};

export const listPanelUsers = async (pool: Pool): Promise<PanelUserPublic[]> => {
  const res = await pool.query<PanelUserRow>(
    "SELECT * FROM panel_users ORDER BY created_at ASC"
  );
  return res.rows.map(toPublicPanelUser);
};

export const createPanelUser = async (
  pool: Pool,
  input: {
    username: string;
    passwordHash: string;
    passwordMd5?: string | null;
    role: PanelUserRole;
    customerId?: string | null;
  }
): Promise<PanelUserPublic> => {
  const res = await pool.query<PanelUserRow>(
    `INSERT INTO panel_users (username, password_hash, password_md5, role, customer_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [input.username, input.passwordHash, input.passwordMd5 ?? null, input.role, input.customerId ?? null]
  );
  return toPublicPanelUser(res.rows[0]!);
};

export const updatePanelUser = async (
  pool: Pool,
  id: string,
  patch: { passwordHash?: string; passwordMd5?: string | null; role?: PanelUserRole; isActive?: boolean }
): Promise<PanelUserPublic | null> => {
  const res = await pool.query<PanelUserRow>(
    `UPDATE panel_users SET
       password_hash = COALESCE($2, password_hash),
       password_md5 = COALESCE($3, password_md5),
       role = COALESCE($4, role),
       is_active = COALESCE($5, is_active),
       updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      id,
      patch.passwordHash ?? null,
      patch.passwordMd5 ?? null,
      patch.role ?? null,
      patch.isActive ?? null
    ]
  );
  const row = res.rows[0];
  return row ? toPublicPanelUser(row) : null;
};

export const markPanelUserLogin = async (pool: Pool, id: string): Promise<void> => {
  await pool.query("UPDATE panel_users SET last_login_at = NOW(), updated_at = NOW() WHERE id = $1", [
    id
  ]);
};
