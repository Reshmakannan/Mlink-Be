// Place at: backend/models/subscriptionModel.js
//
// Assumes your existing backend/config/db.js exports a mysql2/promise pool, e.g.:
//   const mysql = require('mysql2/promise');
//   module.exports = mysql.createPool({ ...your existing connection config });
// If your export is named differently, adjust the require path/name below —
// nothing else in this file needs to change.

const pool = require('../config/db');

async function create({
  userId,
  planType,
  price,
  trialStartDate,
  trialEndDate,
}) {
  const [result] = await pool.query(
    `INSERT INTO subscriptions
       (user_id, plan_type, price, trial_start_date, trial_end_date, status, auto_renewal)
     VALUES (?, ?, ?, ?, ?, 'trialing', 1)`,
    [userId, planType, price, trialStartDate, trialEndDate]
  );
  return findById(result.insertId);
}

async function findById(id) {
  const [rows] = await pool.query(
    'SELECT * FROM subscriptions WHERE id = ? LIMIT 1',
    [id]
  );
  return rows[0] || null;
}

// A user's most recent subscription — the one the Pricing page cares about.
async function findLatestByUserId(userId) {
  const [rows] = await pool.query(
    `SELECT * FROM subscriptions
     WHERE user_id = ?
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

async function updateFields(id, fields) {
  const columns = Object.keys(fields);
  if (columns.length === 0) return findById(id);

  const setClause = columns.map((col) => `${col} = ?`).join(', ');
  const values = columns.map((col) => fields[col]);

  await pool.query(`UPDATE subscriptions SET ${setClause} WHERE id = ?`, [
    ...values,
    id,
  ]);
  return findById(id);
}

module.exports = {
  create,
  findById,
  findLatestByUserId,
  updateFields,
};