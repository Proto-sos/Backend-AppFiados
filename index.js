require("dotenv").config();
const pool = require("./db");
const express = require("express");
const app = express();
const cors = require('cors');

app.use(cors());
app.use(express.json());

// --- PRODUCTOS ---
app.get("/api/products", async (req, res) => {
    try {
        const [rows] = await pool.query("SELECT * FROM productos");
        res.json(rows);
    } catch (error) {
        res.status(500).json({ message: "Error al obtener productos" });
    }
});

// --- FIADOS (CON VALIDACIÓN DE STOCK) ---
app.post("/api/fiados", async (req, res) => {
    const { id_producto, id_cliente, cantidad, descripcion } = req.body;
    try {
        const [producto] = await pool.query("SELECT nombre, stock_actual FROM productos WHERE id_producto = ?", [id_producto]);

        if (producto.length === 0) return res.status(404).json({ message: "Producto no encontrado" });
        if (producto[0].stock_actual < cantidad) {
            return res.status(400).json({ message: `Stock insuficiente. Solo quedan ${producto[0].stock_actual}` });
        }

        await pool.query(
            "INSERT INTO fiados (id_cliente, id_producto, cantidad, descripcion) VALUES (?, ?, ?, ?)",
            [id_cliente, id_producto, cantidad, descripcion || "Sin descripción"]
        );
        res.json({ message: "Fiado registrado con éxito" });
    } catch (error) {
        res.status(500).json({ message: "Error interno" });
    }
});

// --- CLIENTES: BÚSQUEDA Y BALANCE ---
app.get("/api/clientes/buscar/:nombre", async (req, res) => {
    try {
        const [rows] = await pool.query("SELECT id_cliente, nombre FROM clientes WHERE nombre LIKE ?", [`%${req.params.nombre}%`]);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ message: "Error en búsqueda" });
    }
});

app.get('/api/clientes/:id/balance', async (req, res) => {
    const { id } = req.params;
    try {
        const query = `
            SELECT c.nombre AS cliente,
            COALESCE(SUM(f.precio_total), 0) AS deuda,
            COALESCE((SELECT SUM(monto_pagado) FROM pagos WHERE id_cliente = ?), 0) AS pagado
            FROM clientes c
            LEFT JOIN fiados f ON c.id_cliente = f.id_cliente
            WHERE c.id_cliente = ?
            GROUP BY c.id_cliente;`;
        const [results] = await pool.query(query, [id, id]);
        if (results.length > 0) {
            const data = results[0];
            res.json({
                cliente: data.cliente,
                deuda: parseFloat(data.deuda),
                pagado: parseFloat(data.pagado),
                saldo_pendiente: parseFloat(data.deuda) - parseFloat(data.pagado)
            });
        } else { res.status(404).json({ message: "No encontrado" }); }
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// --- HISTORIAL COMBINADO ---
app.get("/api/clientes/:id/historial", async (req, res) => {
    try {
        const query = `
            SELECT fecha, 'FIADO' as tipo, descripcion as detalle, precio_total as monto
            FROM fiados WHERE id_cliente = ?
            UNION ALL
            SELECT fecha, 'PAGO' as tipo, nota as detalle, monto_pagado as monto
            FROM pagos WHERE id_cliente = ?
            ORDER BY fecha DESC`;
        const [rows] = await pool.query(query, [req.params.id, req.params.id]);
        res.json(rows);
    } catch (error) { res.status(500).json({ message: "Error en historial" }); }
});

// --- REGISTRAR PAGOS ---
app.post("/api/pagos", async (req, res) => {
    const { id_cliente, monto, metodo_pago, nota } = req.body;
    try {
        await pool.query(
            "INSERT INTO pagos (id_cliente, monto_pagado, metodo_pago, nota) VALUES (?, ?, ?, ?)",
            [id_cliente, monto, metodo_pago || 'Efectivo', nota || 'Abono a cuenta']
        );
        res.json({ message: "Pago registrado" });
    } catch (error) { res.status(500).json({ message: "Error al pagar" }); }
});
app.get("/api/clientes/resumen-deudas", async (req, res) => {
    try {
        const query = `
            SELECT 
                c.id_cliente,
                c.nombre,
                COALESCE(SUM(f.precio_total), 0) AS total_fiado,
                COALESCE((SELECT SUM(monto_pagado) FROM pagos WHERE id_cliente = c.id_cliente), 0) AS total_pagado,
                (COALESCE(SUM(f.precio_total), 0) - COALESCE((SELECT SUM(monto_pagado) FROM pagos WHERE id_cliente = c.id_cliente), 0)) AS saldo_pendiente
            FROM clientes c
            LEFT JOIN fiados f ON c.id_cliente = f.id_cliente
            GROUP BY c.id_cliente
            ORDER BY saldo_pendiente DESC;
        `;
        const [rows] = await pool.query(query);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ message: "Error al obtener resumen" });
    }
});
app.listen(3000, () => console.log("Servidor en puerto 3000"));