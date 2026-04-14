require("dotenv").config();
const express = require("express");
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// --- CONFIGURACIÓN SQLITE ---
const dbPath = path.resolve(__dirname, 'fiados.db');
const db = new sqlite3.Database(dbPath);

const query = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
});

const run = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
        err ? reject(err) : resolve({ id: this.lastID, changes: this.changes });
    });
});

// --- CREACIÓN AUTOMÁTICA DE TABLAS (LIMPIO) ---
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS productos (
        id_producto INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        stock_actual INTEGER DEFAULT 0,
        precio_costo REAL,
        precio_venta REAL NOT NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS clientes (
        id_cliente INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        telefono TEXT,
        deuda_acumulada REAL DEFAULT 0.00
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS fiados (
        id_fiado INTEGER PRIMARY KEY AUTOINCREMENT,
        id_cliente INTEGER,
        id_producto INTEGER,
        cantidad INTEGER NOT NULL,
        fecha TEXT DEFAULT (datetime('now','localtime')),
        descripcion TEXT,
        precio_total REAL, -- Usaremos esto para el balance
        FOREIGN KEY(id_cliente) REFERENCES clientes(id_cliente),
        FOREIGN KEY(id_producto) REFERENCES productos(id_producto)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS pagos (
        id_pago INTEGER PRIMARY KEY AUTOINCREMENT,
        id_cliente INTEGER,
        monto REAL NOT NULL, 
        metodo_pago TEXT,
        nota TEXT,
        fecha TEXT DEFAULT (datetime('now','localtime')),
        FOREIGN KEY (id_cliente) REFERENCES clientes (id_cliente)
    )`);
    console.log("✅ Base de datos SQLite lista.");
});

// --- RUTAS DE PRODUCTOS ---
app.get("/api/products", async (req, res) => {
    try {
        const rows = await query("SELECT * FROM productos");
        res.json(rows);
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get("/api/products/buscar/:nombre", async (req, res) => {
    try {
        const sql = "SELECT * FROM productos WHERE nombre LIKE ? LIMIT 10";
        const rows = await query(sql, [`%${req.params.nombre}%`]);
        res.json(rows);
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post("/api/products", async (req, res) => {
    const { nombre, precio_venta, stock_actual } = req.body;
    try {
        const result = await run(
            "INSERT INTO productos (nombre, precio_venta, stock_actual, precio_costo) VALUES (?, ?, ?, ?)",
            [nombre, precio_venta, stock_actual || 0, 0]
        );
        res.status(201).json({ id: result.id, nombre });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// --- RUTAS DE CLIENTES (AQUÍ ESTABA EL 404) ---
app.post("/api/clientes", async (req, res) => {
    const { nombre, telefono } = req.body;
    try {
        const result = await run(
            "INSERT INTO clientes (nombre, telefono) VALUES (?, ?)",
            [nombre, telefono]
        );
        res.status(201).json({ id_cliente: result.id, nombre, telefono });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get("/api/clientes/buscar/:nombre", async (req, res) => {
    try {
        const rows = await query("SELECT * FROM clientes WHERE nombre LIKE ? LIMIT 10", [`%${req.params.nombre}%`]);
        res.json(rows);
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// --- BALANCE E HISTORIAL ---
// --- BALANCE DEL CLIENTE ---
app.get('/api/clientes/:id/balance', (req, res) => {
    const { id } = req.params;
    const sql = `
        SELECT 
            (SELECT nombre FROM clientes WHERE id_cliente = ?) as nombre,
            (SELECT IFNULL(SUM(precio_total), 0) FROM fiados WHERE id_cliente = ?) as deuda,
            (SELECT IFNULL(SUM(monto), 0) FROM pagos WHERE id_cliente = ?) as pagado
    `;

    db.get(sql, [id, id, id], (err, row) => {
        if (err) {
            console.error("❌ Error en SQL Balance:", err.message);
            return res.status(500).json({ error: err.message });
        }
        
        // Si row es undefined o el nombre es null, el cliente no existe en la nueva BD
        if (!row || row.nombre === null) {
            return res.status(404).json({ message: "Cliente no existe en la base de datos" });
        }

        res.json({
            cliente: row.nombre,
            deuda: row.deuda || 0,
            pagado: row.pagado || 0,
            saldo_pendiente: (row.deuda || 0) - (row.pagado || 0)
        });
    });
});

// --- HISTORIAL DE MOVIMIENTOS ---
app.get('/api/clientes/:id/historial', (req, res) => {
    const { id } = req.params;
    const sql = `
        SELECT fecha, 'FIADO' as tipo, precio_total as monto FROM fiados WHERE id_cliente = ?
        UNION ALL
        SELECT fecha, 'PAGO' as tipo, monto FROM pagos WHERE id_cliente = ?
        ORDER BY fecha DESC`;

    db.all(sql, [id, id], (err, rows) => {
        if (err) {
            console.error("❌ Error en SQL Historial:", err.message);
            return res.status(500).json({ error: err.message });
        }
        // Si no hay filas, devolvemos un array vacío en lugar de error
        res.json(rows || []);
    });
});

// --- FIADOS MÚLTIPLES ---
app.post("/api/fiados/multiples", (req, res) => {
    const { id_cliente, productos } = req.body;
    db.serialize(async () => {
        try {
            db.run("BEGIN TRANSACTION");
            for (const p of productos) {
                const precioTotal = p.precio_venta * p.cantidad;
                await run(
                    "INSERT INTO fiados (id_cliente, id_producto, cantidad, precio_total, descripcion) VALUES (?, ?, ?, ?, ?)",
                    [id_cliente, p.id_producto, p.cantidad, precioTotal, "Compra Carrito"]
                );
                await run("UPDATE productos SET stock_actual = stock_actual - ? WHERE id_producto = ?", [p.cantidad, p.id_producto]);
            }
            db.run("COMMIT", () => res.json({ message: "Fiado procesado" }));
        } catch (error) {
            db.run("ROLLBACK");
            res.status(400).json({ message: error.message });
        }
    });
});

app.post("/api/pagos", async (req, res) => {
    const { id_cliente, monto, metodo_pago, nota } = req.body;
    try {
        await run("INSERT INTO pagos (id_cliente, monto, metodo_pago, nota) VALUES (?, ?, ?, ?)", 
            [id_cliente, monto, metodo_pago || 'Efectivo', nota || 'Abono']);
        res.json({ message: "Pago registrado" });
    } catch (error) { res.status(500).json({ error: error.message }); }
});
// --- RUTA: RESUMEN GENERAL DE DEUDAS ---
app.get("/api/clientes/resumen-deudas", async (req, res) => {
    try {
        const sql = `
            SELECT 
                c.id_cliente, 
                c.nombre, 
                COALESCE((SELECT SUM(precio_total) FROM fiados WHERE id_cliente = c.id_cliente), 0) AS total_fiado,
                COALESCE((SELECT SUM(monto) FROM pagos WHERE id_cliente = c.id_cliente), 0) AS total_pagado
            FROM clientes c
            GROUP BY c.id_cliente`;
        
        const rows = await query(sql);
        
        // Formateamos la respuesta para que el frontend la entienda
        const resumen = rows.map(r => ({
            id_cliente: r.id_cliente,
            nombre: r.nombre,
            total_fiado: Number(r.total_fiado) || 0,
            saldo_pendiente: (Number(r.total_fiado) || 0) - (Number(r.total_pagado) || 0)
        }));
        
        res.json(resumen);
    } catch (error) {
        console.error("❌ Error en resumen-deudas:", error.message);
        res.status(500).json({ error: error.message });
    }
});
app.listen(3000, () => console.log("🚀 Servidor en http://localhost:3000"));