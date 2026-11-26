const express = require("express");
const sql = require("mssql");

const app = express();
app.disable("x-powered-by");

// --- Seguridad: solo el proxy (edge function sap-proxy) puede llamar esta API ---
// La llave vive en la variable de entorno API_KEY de Render; nunca en el código.
const crypto = require("crypto");
function requireApiKey(req, res, next) {
  const expected = process.env.API_KEY;
  if (!expected) {
    // Falla cerrado: sin llave configurada no se sirve nada.
    console.error("API_KEY no configurada; solicitud rechazada");
    return res.status(503).json({ error: "service_unavailable" });
  }
  const given = req.get("x-api-key") || "";
  // Compara hashes de longitud fija para que el tiempo no revele la llave.
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  if (!crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}
// Ruta pública SOLO para el health check de Render (no devuelve datos).
app.get("/healthz", (req, res) => res.status(200).send("ok"));

app.use(requireApiKey);

app.use(express.json());

// Configuración desde variables de ambiente
const config = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  database: process.env.DB_DATABASE,
  options: {
    encrypt: true,
    trustServerCertificate: false
  },
  requestTimeout: 60000
};

// ---------------------------------------------------
// Aquí agregas o quitas almacenes por centro
// ---------------------------------------------------
const INVENTARIO_FILTROS = {
  PAL3: ["P109","P110", "P111", "P112", "P113"],
  PAL4: ["P024","P027", "P029", "P030", "P035"]
};

// ---------------------------------------------------
// Ruta inicial para validar que la API está viva
// ---------------------------------------------------
app.get("/", (req, res) => {
  res.send("API Inventarios Logística funcionando correctamente");
});

// ---------------------------------------------------
// Endpoint: ver almacenes existentes en PAL3 y PAL4
// ---------------------------------------------------
app.get("/inventario/almacenes", async (req, res) => {
  try {
    const pool = await sql.connect(config);

    const result = await pool.request().query(`
      SELECT
          WERKS AS Centro,
          LGORT AS Almacen,
          COUNT(*) AS Registros,
          SUM(TRY_CONVERT(DECIMAL(18,3), [CLABS])) AS CantidadTotal
      FROM MCHB
      WHERE LTRIM(RTRIM(WERKS)) IN ('PAL3', 'PAL4')
      GROUP BY
          WERKS,
          LGORT
      ORDER BY
          WERKS,
          LGORT;
    `);

    res.json(result.recordset);

  } catch (err) {
    console.error("Error en " + req.path + ":", err.message);
    res.status(500).json({ error: "internal_error" });
  }
});

// ---------------------------------------------------
// Endpoint final: inventario por centro, almacén, material y lote
// Toma los centros y almacenes desde INVENTARIO_FILTROS
// ---------------------------------------------------
app.get("/inventario/lotes", async (req, res) => {
  try {
    const pool = await sql.connect(config);
    const request = pool.request();

    let condiciones = [];
    let index = 0;

    Object.entries(INVENTARIO_FILTROS).forEach(([centro, almacenes]) => {
      almacenes.forEach((almacen) => {
        const centroParam = `centro${index}`;
        const almacenParam = `almacen${index}`;

        request.input(centroParam, sql.VarChar, centro);
        request.input(almacenParam, sql.VarChar, almacen);

        condiciones.push(`
          (
            LTRIM(RTRIM(WERKS)) = @${centroParam}
            AND LTRIM(RTRIM(LGORT)) = @${almacenParam}
          )
        `);

        index++;
      });
    });

    const whereDinamico = condiciones.join(" OR ");

    const result = await request.query(`
      SELECT
          WERKS AS Centro,
          LGORT AS Almacen,
          MATNR AS Material,
          CHARG AS Lote,
          SUM(TRY_CONVERT(DECIMAL(18,3), [CLABS])) AS CantidadReal
      FROM MCHB
      WHERE ${whereDinamico}
      GROUP BY
          WERKS,
          LGORT,
          MATNR,
          CHARG
      ORDER BY
          WERKS,
          LGORT,
          MATNR,
          CHARG;
    `);

    res.json(result.recordset);

  } catch (err) {
    console.error("Error en " + req.path + ":", err.message);
    res.status(500).json({ error: "internal_error" });
  }
});

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`API Inventarios Logística corriendo en puerto ${PORT}`);
});
