const express = require("express");
const path = require("path");
const fs = require("fs");
const initSqlJs = require("sql.js");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const dbDir = path.join(__dirname, "database");
const dbFile = path.join(dbDir, "financeiro.db");
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

// Adaptador pequeno para manter a mesma forma de uso do better-sqlite3,
// mas utilizando SQLite em WebAssembly (sem compilação nativa no Windows).
function createDatabase(SQL, filePath) {
  const database = fs.existsSync(filePath)
    ? new SQL.Database(new Uint8Array(fs.readFileSync(filePath)))
    : new SQL.Database();
  let inTransaction = false;

  function save() {
    if (!inTransaction) fs.writeFileSync(filePath, Buffer.from(database.export()));
  }

  const db = {
    exec(sql) {
      database.exec(sql);
      save();
    },
    pragma(command) {
      // foreign_keys é suportado pelo SQLite WASM. WAL não é necessário
      // para esta aplicação local de um único processo.
      if (/^\s*foreign_keys/i.test(command)) database.run(`PRAGMA ${command}`);
    },
    prepare(sql) {
      return {
        get(...params) {
          const stmt = database.prepare(sql);
          try {
            stmt.bind(params);
            return stmt.step() ? stmt.getAsObject() : undefined;
          } finally { stmt.free(); }
        },
        all(...params) {
          const stmt = database.prepare(sql);
          const rows = [];
          try {
            stmt.bind(params);
            while (stmt.step()) rows.push(stmt.getAsObject());
            return rows;
          } finally { stmt.free(); }
        },
        run(...params) {
          database.run(sql, params);
          const changes = database.getRowsModified();
          const idRows = database.exec("SELECT last_insert_rowid() AS id");
          const lastInsertRowid = idRows.length ? idRows[0].values[0][0] : 0;
          save();
          return { changes, lastInsertRowid };
        }
      };
    },
    transaction(callback) {
      return (...args) => {
        database.run("BEGIN");
        inTransaction = true;
        try {
          const result = callback(...args);
          database.run("COMMIT");
          inTransaction = false;
          save();
          return result;
        } catch (error) {
          try { database.run("ROLLBACK"); } catch (_) {}
          inTransaction = false;
          throw error;
        }
      };
    }
  };
  return db;
}

async function start() {
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(__dirname, "node_modules", "sql.js", "dist", file)
  });
  const db = createDatabase(SQL, dbFile);
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL CHECK(type IN ('receita','despesa')),
      color TEXT NOT NULL DEFAULT '#8b6bb1',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('receita','despesa')),
      description TEXT NOT NULL,
      client_name TEXT NOT NULL DEFAULT '',
      amount REAL NOT NULL CHECK(amount > 0),
      date TEXT NOT NULL,
      category_id INTEGER NOT NULL,
      payment_method TEXT NOT NULL DEFAULT 'Não informado',
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(category_id) REFERENCES categories(id) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
    CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);
  `);

  // Migração compatível com bancos criados antes do campo de cliente.
  const transactionColumns = db.prepare("PRAGMA table_info(transactions)").all();
  if (!transactionColumns.some(column => column.name === "client_name")) {
    db.exec("ALTER TABLE transactions ADD COLUMN client_name TEXT NOT NULL DEFAULT ''");
  }

  const count = db.prepare("SELECT COUNT(*) AS total FROM categories").get().total;
  if (count === 0) {
    const insert = db.prepare("INSERT INTO categories (name,type,color) VALUES (?,?,?)");
    db.transaction(() => {
      [
        ["Serviços de depilação", "receita", "#8b6bb1"],
        ["Serviços de estética", "receita", "#c18aab"],
        ["Venda de produtos", "receita", "#6d9b87"],
        ["Materiais e produtos", "despesa", "#d58b73"],
        ["Aluguel", "despesa", "#b18b65"],
        ["Água e energia", "despesa", "#6d91b2"],
        ["Internet e telefone", "despesa", "#8a91a8"],
        ["Outras despesas", "despesa", "#a17d91"]
      ].forEach(row => insert.run(...row));
    })();
  }

  const txCount = db.prepare("SELECT COUNT(*) AS total FROM transactions").get().total;
  if (txCount === 0) {
    const getCat = (name) => db.prepare("SELECT id FROM categories WHERE name=?").get(name).id;
    const insertTx = db.prepare(`INSERT INTO transactions
      (type,description,amount,date,category_id,payment_method,notes) VALUES (?,?,?,?,?,?,?)`);
    const today = new Date();
    const date = (offset) => {
      const d = new Date(today);
      d.setDate(d.getDate() - offset);
      return d.toISOString().slice(0,10);
    };
    const samples = [
      ["receita","Depilação - pernas",120,date(1),getCat("Serviços de depilação"),"Pix","Pagamento recebido"],
      ["receita","Limpeza de pele",150,date(2),getCat("Serviços de estética"),"Cartão de débito",""],
      ["receita","Depilação - axilas",45,date(4),getCat("Serviços de depilação"),"Dinheiro",""],
      ["receita","Creme pós-depilação",38,date(6),getCat("Venda de produtos"),"Pix",""],
      ["despesa","Compra de materiais",210,date(1),getCat("Materiais e produtos"),"Pix","Reposição de estoque"],
      ["despesa","Conta de energia",145,date(3),getCat("Água e energia"),"Boleto",""],
      ["despesa","Internet",89.90,date(5),getCat("Internet e telefone"),"Pix",""],
      ["despesa","Aluguel do espaço",850,date(8),getCat("Aluguel"),"Transferência",""]
    ];
    db.transaction(() => samples.forEach(row => insertTx.run(...row)))();
  }

  app.use(express.json({ limit: "100kb" }));
  app.use(express.static(path.join(__dirname, "public")));

  // Sessões locais: cookies HttpOnly e SameSite=Strict. Ao reiniciar o servidor,
  // o usuário precisa entrar novamente.
  const sessions = new Map();
  const loginAttempts = new Map();
  const SESSION_DURATION = 8 * 60 * 60 * 1000;
  function cookieValue(req, name) {
    const cookies = (req.headers.cookie || "").split(";");
    for (const item of cookies) {
      const index = item.indexOf("=");
      if (index < 0) continue;
      if (item.slice(0, index).trim() === name) return decodeURIComponent(item.slice(index + 1).trim());
    }
    return "";
  }
  function currentUser(req) {
    const token = cookieValue(req, "essenza_session");
    const session = sessions.get(token);
    if (!session || session.expiresAt < Date.now()) {
      if (token) sessions.delete(token);
      return null;
    }
    session.expiresAt = Date.now() + SESSION_DURATION;
    return session.user;
  }
  function setSession(res, user) {
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, { user, expiresAt: Date.now() + SESSION_DURATION });
    res.setHeader("Set-Cookie", `essenza_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DURATION / 1000}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
  }
  function safeUser(user) { return { id: user.id, name: user.name, email: user.email }; }

  app.get("/api/auth/status", (req, res) => {
    const account = db.prepare("SELECT COUNT(*) AS total FROM users").get().total > 0;
    res.json({ accountConfigured: account });
  });
  app.get("/api/auth/me", (req, res) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ error: "Faça login para continuar." });
    res.json({ user });
  });
  app.post("/api/auth/register", (req, res) => {
    // Permite criar novas contas com e-mails diferentes. As contas deste sistema
    // pertencem ao mesmo estabelecimento e compartilham os registros financeiros.
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    if (name.length < 2) return res.status(400).json({ error: "Informe seu nome (pelo menos 2 caracteres)." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Informe um e-mail válido." });
    if (password.length < 8) return res.status(400).json({ error: "A senha deve ter pelo menos 8 caracteres." });
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.scryptSync(password, salt, 64).toString("hex");
    try {
      const result = db.prepare("INSERT INTO users(name,email,password_hash,password_salt) VALUES(?,?,?,?)").run(name, email, hash, salt);
      const user = safeUser(db.prepare("SELECT id,name,email FROM users WHERE id=?").get(result.lastInsertRowid));
      setSession(res, user);
      res.status(201).json({ user });
    } catch (error) {
      if (String(error && error.message || "").toLowerCase().includes("unique")) {
        return res.status(409).json({ error: "Este e-mail já está cadastrado. Entre na sua conta ou use outro e-mail." });
      }
      console.error("Erro ao criar conta:", error);
      return res.status(500).json({ error: "Não foi possível criar a conta agora. Confira se o banco de dados está acessível e tente novamente." });
    }
  });
  app.post("/api/auth/login", (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || "local";
    const attempt = loginAttempts.get(ip) || { count: 0, blockedUntil: 0 };
    if (attempt.blockedUntil > Date.now()) return res.status(429).json({ error: "Muitas tentativas. Aguarde alguns minutos e tente novamente." });
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const record = db.prepare("SELECT * FROM users WHERE email=?").get(email);
    let valid = false;
    if (record && password) {
      const candidate = crypto.scryptSync(password, record.password_salt, 64);
      const expected = Buffer.from(record.password_hash, "hex");
      valid = candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
    }
    if (!valid) {
      attempt.count += 1;
      if (attempt.count >= 5) { attempt.count = 0; attempt.blockedUntil = Date.now() + 5 * 60 * 1000; }
      loginAttempts.set(ip, attempt);
      return res.status(401).json({ error: "E-mail ou senha incorretos." });
    }
    loginAttempts.delete(ip);
    const user = safeUser(record);
    setSession(res, user);
    res.json({ user });
  });
  app.post("/api/auth/logout", (req, res) => {
    const token = cookieValue(req, "essenza_session");
    if (token) sessions.delete(token);
    res.setHeader("Set-Cookie", "essenza_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
    res.json({ message: "Sessão encerrada." });
  });

  // Protege todos os endpoints de dados: receitas, despesas, categorias e relatórios.
  app.use("/api", (req, res, next) => {
    if (req.path === "/auth/status" || req.path.startsWith("/auth/")) return next();
    if (req.path === "/health") return next();
    const user = currentUser(req);
    if (!user) return res.status(401).json({ error: "Sua sessão expirou. Entre novamente." });
    req.user = user;
    next();
  });

  function validTransaction(body) {
    const { type, description, amount, date, category_id } = body;
    if (!["receita", "despesa"].includes(type)) return "Tipo de movimentação inválido.";
    if (!description || !String(description).trim()) return "Informe a descrição.";
    if (type === "receita" && (!body.client_name || !String(body.client_name).trim())) return "Informe o nome da cliente para registrar uma receita.";
    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) return "Informe um valor maior que zero.";
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return "Informe uma data válida.";
    const category = db.prepare("SELECT id,type FROM categories WHERE id=?").get(Number(category_id));
    if (!category) return "Selecione uma categoria existente.";
    if (category.type !== type) return "A categoria não corresponde ao tipo da movimentação.";
    return null;
  }

  app.get("/api/health", (req, res) => res.json({ status: "ok", database: "connected", engine: "SQLite WASM" }));

  app.get("/api/categories", (req, res) => {
    const { type } = req.query;
    const rows = type && ["receita","despesa"].includes(type)
      ? db.prepare("SELECT * FROM categories WHERE type=? ORDER BY name").all(type)
      : db.prepare("SELECT * FROM categories ORDER BY type,name").all();
    res.json(rows);
  });

  app.post("/api/categories", (req, res) => {
    const { name, type, color = "#8b6bb1" } = req.body;
    if (!name || !String(name).trim() || !["receita","despesa"].includes(type))
      return res.status(400).json({ error: "Informe um nome e um tipo válido." });
    try {
      const result = db.prepare("INSERT INTO categories(name,type,color) VALUES(?,?,?)").run(String(name).trim(), type, color);
      res.status(201).json(db.prepare("SELECT * FROM categories WHERE id=?").get(result.lastInsertRowid));
    } catch (e) { res.status(409).json({ error: "Já existe uma categoria com esse nome." }); }
  });

  app.put("/api/categories/:id", (req, res) => {
    const { name, type, color } = req.body;
    if (!name || !String(name).trim() || !["receita","despesa"].includes(type))
      return res.status(400).json({ error: "Informe um nome e um tipo válido." });
    const used = db.prepare("SELECT COUNT(*) AS total FROM transactions WHERE category_id=?").get(req.params.id).total;
    if (used) return res.status(409).json({ error: "Esta categoria já possui movimentações. Não é possível alterar seu tipo ou nome." });
    try {
      const result = db.prepare("UPDATE categories SET name=?,type=?,color=? WHERE id=?").run(String(name).trim(), type, color || "#8b6bb1", req.params.id);
      if (!result.changes) return res.status(404).json({ error: "Categoria não encontrada." });
      res.json(db.prepare("SELECT * FROM categories WHERE id=?").get(req.params.id));
    } catch (e) { res.status(409).json({ error: "Já existe uma categoria com esse nome." }); }
  });

  app.delete("/api/categories/:id", (req, res) => {
    try {
      const result = db.prepare("DELETE FROM categories WHERE id=?").run(req.params.id);
      if (!result.changes) return res.status(404).json({ error: "Categoria não encontrada." });
      res.json({ message: "Categoria excluída." });
    } catch (e) { res.status(409).json({ error: "Não é possível excluir uma categoria que possui movimentações." }); }
  });

  app.get("/api/transactions", (req, res) => {
    const { type, from, to, category_id, search } = req.query;
    let sql = `SELECT t.*, c.name AS category_name, c.color AS category_color FROM transactions t JOIN categories c ON c.id=t.category_id WHERE 1=1`;
    const params = [];
    if (type && ["receita","despesa"].includes(type)) { sql += " AND t.type=?"; params.push(type); }
    if (from) { sql += " AND t.date>=?"; params.push(from); }
    if (to) { sql += " AND t.date<=?"; params.push(to); }
    if (category_id) { sql += " AND t.category_id=?"; params.push(Number(category_id)); }
    if (search) { sql += " AND (t.description LIKE ? OR c.name LIKE ? OR t.client_name LIKE ?)"; params.push(`%${search}%`,`%${search}%`,`%${search}%`); }
    sql += " ORDER BY t.date DESC,t.id DESC";
    res.json(db.prepare(sql).all(...params));
  });

  app.post("/api/transactions", (req, res) => {
    const error = validTransaction(req.body);
    if (error) return res.status(400).json({ error });
    const { type, description, client_name = "", amount, date, category_id, payment_method = "Não informado", notes = "" } = req.body;
    const result = db.prepare(`INSERT INTO transactions(type,description,client_name,amount,date,category_id,payment_method,notes) VALUES(?,?,?,?,?,?,?,?)`).run(type, String(description).trim(), type === "receita" ? String(client_name).trim() : "", Number(amount), date, Number(category_id), payment_method, notes);
    res.status(201).json(db.prepare(`SELECT t.*,c.name AS category_name,c.color AS category_color FROM transactions t JOIN categories c ON c.id=t.category_id WHERE t.id=?`).get(result.lastInsertRowid));
  });

  app.put("/api/transactions/:id", (req, res) => {
    const error = validTransaction(req.body);
    if (error) return res.status(400).json({ error });
    const { type, description, client_name = "", amount, date, category_id, payment_method = "Não informado", notes = "" } = req.body;
    const result = db.prepare(`UPDATE transactions SET type=?,description=?,client_name=?,amount=?,date=?,category_id=?,payment_method=?,notes=? WHERE id=?`).run(type, String(description).trim(), type === "receita" ? String(client_name).trim() : "", Number(amount), date, Number(category_id), payment_method, notes, req.params.id);
    if (!result.changes) return res.status(404).json({ error: "Movimentação não encontrada." });
    res.json(db.prepare(`SELECT t.*,c.name AS category_name,c.color AS category_color FROM transactions t JOIN categories c ON c.id=t.category_id WHERE t.id=?`).get(req.params.id));
  });

  app.delete("/api/transactions/:id", (req, res) => {
    const result = db.prepare("DELETE FROM transactions WHERE id=?").run(req.params.id);
    if (!result.changes) return res.status(404).json({ error: "Movimentação não encontrada." });
    res.json({ message: "Movimentação excluída." });
  });

  app.get("/api/dashboard", (req, res) => {
    const month = req.query.month || new Date().toISOString().slice(0,7);
    const start = `${month}-01`;
    const end = `${month}-31`;
    const totals = db.prepare(`SELECT COALESCE(SUM(CASE WHEN type='receita' THEN amount ELSE 0 END),0) AS receitas, COALESCE(SUM(CASE WHEN type='despesa' THEN amount ELSE 0 END),0) AS despesas, COUNT(*) AS quantidade FROM transactions WHERE date BETWEEN ? AND ?`).get(start,end);
    const byDay = db.prepare(`SELECT date, SUM(CASE WHEN type='receita' THEN amount ELSE 0 END) AS receitas, SUM(CASE WHEN type='despesa' THEN amount ELSE 0 END) AS despesas FROM transactions WHERE date BETWEEN ? AND ? GROUP BY date ORDER BY date`).all(start,end);
    const latest = db.prepare(`SELECT t.*,c.name AS category_name,c.color AS category_color FROM transactions t JOIN categories c ON c.id=t.category_id ORDER BY date DESC,id DESC LIMIT 6`).all();
    const byCategory = db.prepare(`SELECT c.name,c.color,SUM(t.amount) AS total,t.type FROM transactions t JOIN categories c ON c.id=t.category_id WHERE t.date BETWEEN ? AND ? GROUP BY c.id ORDER BY total DESC`).all(start,end);
    res.json({ month, ...totals, saldo: totals.receitas - totals.despesas, byDay, latest, byCategory });
  });

  app.get("/api/reports", (req, res) => {
    const { from, to } = req.query;
    const start = from || "2000-01-01";
    const end = to || "2999-12-31";
    const totals = db.prepare(`SELECT COALESCE(SUM(CASE WHEN type='receita' THEN amount ELSE 0 END),0) AS receitas, COALESCE(SUM(CASE WHEN type='despesa' THEN amount ELSE 0 END),0) AS despesas, COUNT(*) AS quantidade FROM transactions WHERE date BETWEEN ? AND ?`).get(start,end);
    const categories = db.prepare(`SELECT c.name,c.type,c.color,SUM(t.amount) AS total,COUNT(t.id) AS quantidade FROM categories c LEFT JOIN transactions t ON t.category_id=c.id AND t.date BETWEEN ? AND ? GROUP BY c.id ORDER BY c.type,c.name`).all(start,end);
    res.json({ ...totals, saldo: totals.receitas-totals.despesas, categories });
  });

  app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
  app.listen(PORT, () => console.log(`Sistema disponível em http://localhost:${PORT}`));
}

start().catch((error) => {
  console.error("Não foi possível iniciar o banco de dados SQLite:", error);
  process.exit(1);
});
