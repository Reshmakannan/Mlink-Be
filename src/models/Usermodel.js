const pool = require("../config/db");

const UserModel = {
  async findByEmail(email) {
    const [rows] = await pool.query(
      "SELECT * FROM users WHERE email = ? LIMIT 1",
      [email]
    );
    return rows[0];
  },

  async create({ name, email, passwordHash }) {
    const [result] = await pool.query(
      "INSERT INTO users (name, email, password) VALUES (?, ?, ?)",
      [name, email, passwordHash]
    );
    return { id: result.insertId, name, email };
  },
};

module.exports = UserModel;